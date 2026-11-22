import {createHash} from 'node:crypto';
import {and,asc,count,desc,eq,gte,inArray,lte,ne,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {AttributionQuery,ReportPeriod,TrafficQuery} from '../../lib/portable-web-attribution';
import {recordAccess,type RecordAccessActor} from './record-access-store';
import {ApiError} from '../../lib/api-error';
import {lockPortableLoginSession,type PostgresSessionActor} from './identity-store';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {leadForms,leadInquiries} from './lead-form-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces} from './workspace-schema';
import {formConversions as conversions,pageEvents as visits,trackingSites as sites,type JourneyTouch} from './web-attribution-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type SiteInput={id:string;name:string;origin:string;enabled:boolean;revision:number};
type EventInput={siteId:string;eventId:string;visitorToken:string;path:string;source?:string;medium?:string;campaign?:string};
export type AttributionHint={siteId:string;visitorToken:string};
const siteFields={id:sites.id,name:sites.name,origin:sites.origin,enabled:sites.enabled,revision:sites.revision};
export const attributionWindowMs=30*86_400_000;
function reportingWindow(now:number,period:ReportPeriod='30d',asOf=now){
  const day=86_400_000;
  const anchor=Math.min(now,asOf);
  const days=period==='previous7d'?14:period==='7d'?7:period==='24h'?1:30;
  return {
    start:Math.max(now-attributionWindowMs,anchor-days*day),
    end:period==='previous7d'?anchor-7*day-1:anchor,
  };
}
const clock=sql<number>`floor(extract(epoch from statement_timestamp())*1000)::float8`;
const hash=(siteId:string,token:string)=>createHash('sha256').update(siteId.toLowerCase()+'\0'+token).digest('hex');
const unavailable=()=>new ApiError(404,'Tracking site or inquiry unavailable.');
const stale=()=>new ApiError(409,'This site changed. Reload its settings.');

export function saveAttributionSite(db:Db,actor:PostgresSessionActor,input:SiteInput){
  return db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again.');
    const workspace=await lockRecordWorkspace(tx,actor.userId,true,undefined,undefined,true);
    if(!workspace)throw unavailable();
    const owned=eq(sites.workspaceId,workspace),key=and(owned,eq(sites.id,input.id));
    const [current]=await tx.select(siteFields).from(sites).where(key).for('no key update');
    if((current?.revision??0)!==input.revision)throw stale();
    if(current){
      if(current.origin!==input.origin)throw new ApiError(409,'Use a new tracking site for a different website origin.');
      const [updated]=await tx.update(sites).set({name:input.name,enabled:input.enabled,revision:current.revision+1}).where(key).returning(siteFields);
      return updated;
    }
    const [capacity]=await tx.select({n:count()}).from(sites).where(owned);
    if(capacity.n>=20)throw new ApiError(409,'This workspace already has 20 tracking sites.');
    const [created]=await tx.insert(sites).values({...input,revision:1,workspaceId:workspace}).onConflictDoNothing().returning(siteFields);
    if(!created)throw new ApiError(409,'That site or website origin is already registered.');
    return created;
  });
}

export async function trackingSite(db:Db,siteId:string,origin:string){
  const [site]=await db.select({id:sites.id,origin:sites.origin}).from(sites)
    .where(and(eq(sites.id,siteId),eq(sites.origin,origin),eq(sites.enabled,true)));
  return site;
}

// Each bounded sweep removes more rows than a single intake can add. SKIP LOCKED allows
// another site or a maintenance pass to prune independently on a busy installation.
export async function pruneAttribution(db:Db){
  await db.execute(sql`DELETE FROM portable_page_events v USING
    (SELECT site_id,event_id FROM portable_page_events WHERE at < ${clock}-${attributionWindowMs}
     ORDER BY at LIMIT 256 FOR UPDATE SKIP LOCKED) old
    WHERE v.site_id=old.site_id AND v.event_id=old.event_id`);
  await db.execute(sql`DELETE FROM portable_form_conversions c USING
    (SELECT workspace_id,inquiry_id FROM portable_form_conversions WHERE converted_at < ${clock}-${attributionWindowMs}
     ORDER BY converted_at LIMIT 256 FOR UPDATE SKIP LOCKED) old
    WHERE c.workspace_id=old.workspace_id AND c.inquiry_id=old.inquiry_id`);
}

export async function recordPageview(db:Db,origin:string,input:EventInput){
  return db.transaction(async tx=>{
    const [site]=await tx.select({id:sites.id}).from(sites)
      .where(and(eq(sites.id,input.siteId),eq(sites.origin,origin),eq(sites.enabled,true))).for('no key update');
    if(!site)throw unavailable();
    const scope=eq(visits.siteId,site.id),visitorHash=hash(site.id,input.visitorToken);
    const [duplicate]=await tx.select({visitor:visits.visitorHash}).from(visits).where(and(scope,eq(visits.eventId,input.eventId)));
    if(duplicate){
      if(duplicate.visitor!==visitorHash)throw new ApiError(409,'Visit identifier already used.');
      return {accepted:true,duplicate:true};
    }
    const [{at}]=await tx.select({at:clock}).from(sql`(VALUES(1)) AS now(n)`);
    const hour=gte(visits.at,Math.floor(at/3_600_000)*3_600_000);
    const [siteCount]=await tx.select({n:count()}).from(visits).where(and(scope,hour));
    if(siteCount.n>=5000)throw new ApiError(429,'This site reached its hourly pageview limit.');
    const [visitorCount]=await tx.select({n:count()}).from(visits).where(and(scope,eq(visits.visitorHash,visitorHash),hour));
    if(visitorCount.n>=120)throw new ApiError(429,'This visitor reached the hourly pageview limit.');
    await tx.insert(visits).values({siteId:site.id,visitorHash,eventId:input.eventId,at,path:input.path,
      source:input.source||'Direct',medium:input.medium||'',campaign:input.campaign||''});
    await pruneAttribution(tx);
    return {accepted:true,duplicate:false};
  });
}

function visitCounts(column:'medium'|'campaign'){
  return sql`(SELECT jsonb_object_agg(label,n) FROM (
    SELECT ${sql.identifier(column)} AS label,count(*) AS n FROM eligible GROUP BY 1
  ) labels)`;
}

export async function attributeInquiry(tx:Tx,workspaceId:string,inquiryId:string,at:number,hint:AttributionHint){
  const [site]=await tx.select({id:sites.id}).from(sites)
    .where(and(eq(sites.id,hint.siteId),eq(sites.workspaceId,workspaceId),eq(sites.enabled,true))).for('share');
  if(!site)return;
  // Materialize the eligible events once. Credits use every eligible visit, including those past the displayed path limit.
  await tx.execute(sql`WITH eligible AS MATERIALIZED (
    SELECT event_id,sequence,at,path,source,medium,campaign
    FROM portable_page_events WHERE site_id=${site.id} AND visitor_hash=${hash(site.id,hint.visitorToken)}
      AND at BETWEEN ${at-attributionWindowMs} AND ${at}
  ), counts AS (SELECT source,count(*) AS n FROM eligible GROUP BY source),
  preview AS (
    (SELECT * FROM eligible ORDER BY at,sequence LIMIT 50)
    UNION
    (SELECT * FROM eligible ORDER BY at DESC,sequence DESC LIMIT 50)
  )
  INSERT INTO portable_form_conversions (workspace_id,inquiry_id,site_id,converted_at,total,first_source,last_source,counts,utm_counts,path)
  SELECT ${workspaceId},${inquiryId},${site.id},${at},sum(n)::int,
    (SELECT source FROM eligible ORDER BY at,sequence LIMIT 1),
    (SELECT source FROM eligible ORDER BY at DESC,sequence DESC LIMIT 1), jsonb_object_agg(source,n),
    jsonb_build_object('medium',${visitCounts('medium')},'campaign',${visitCounts('campaign')}),
    (SELECT jsonb_agg(jsonb_build_object('id',event_id,'at',at,'path',path,'source',source,'medium',medium,'campaign',campaign)
      ORDER BY at,sequence) FROM preview)
  FROM counts HAVING count(*)>0`);
}

const attributionRow={inquiryId:conversions.inquiryId,siteId:conversions.siteId,convertedAt:conversions.convertedAt,
  formId:leadInquiries.formId,formTitle:sql<string>`${leadForms.definition}->>'title'`};
type Conversion={inquiryId:string;siteId:string;convertedAt:number;formId:string;formTitle:string};
type Source={source:string;first:number;last:number;linear:number};
type Credit={label:string;first:number;last:number;linear:number};
type Dimension='source'|'medium'|'campaign';
const unknownVisits='(Earlier visits unavailable)';
const untagged='(Not tagged)';

// Older snapshots retain the ends of long paths. Missing middle visits earn
// their own linear share, leaving the known first and last touch intact.
function dimensionCounts(dimension:'medium'|'campaign'){
  const key=sql`${dimension}::text`;
  return sql`coalesce(${conversions.utmCounts}->${key}, (
    SELECT jsonb_object_agg(label,n) FROM (
      SELECT coalesce(touch->>${key},'') AS label,count(*) AS n
      FROM jsonb_array_elements(${conversions.path}) touch GROUP BY 1
      UNION ALL
      SELECT ${unknownVisits},${conversions.total}-jsonb_array_length(${conversions.path})
      WHERE ${conversions.total}>jsonb_array_length(${conversions.path})
    ) known
  ))`;
}

function ownedTrackingSites(tx:Tx,actorId:string){
  return tx.select(siteFields).from(sites).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,sites.workspaceId))
    .where(eq(privateWorkspaces.ownerId,actorId)).orderBy(asc(sites.name),asc(sites.id)).limit(20);
}

export async function readTraffic(db:Db,actorId:string,query:TrafficQuery){
  return db.transaction(async tx=>{
    const owned=await ownedTrackingSites(tx,actorId);
    if(query.siteId&&!owned.some(site=>site.id===query.siteId))throw unavailable();
    type TrafficRow={label:string;views:number;visitors:number};
    const empty={sites:owned,pageviews:0,visitors:0,rows:[] as TrafficRow[],next:null as {afterViews:number;afterLabel:string;through:number}|null};
    if(!owned.length)return empty;
    const [{now}]=await tx.select({now:clock}).from(sql`(VALUES(1)) AS now(n)`);
    // Exclude new arrivals while paging, and honor the retention cutoff on every read.
    const through=Math.min(query.through??now,now);
    const range=reportingWindow(now,query.period,through);
    const scope=and(query.siteId?eq(visits.siteId,query.siteId):inArray(visits.siteId,owned.map(site=>site.id)),
      gte(visits.at,range.start),lte(visits.at,range.end));
    const label=query.group==='page'?sql`${sites.origin} || ${visits.path}`:
      sql`coalesce(nullif(${visits[query.group]},''),${untagged})`;
    const results=await tx.execute<TrafficRow&{overall:boolean}>(sql`
      WITH traffic AS (
        SELECT (${label}) COLLATE "C" AS label, ${visits.visitorHash} AS visitor
        FROM ${visits} JOIN ${sites} ON ${sites.id}=${visits.siteId} WHERE ${scope}
      ), totals AS (
        SELECT label, grouping(label)=1 AS overall, count(*)::int AS views, count(DISTINCT visitor)::int AS visitors
        FROM traffic GROUP BY GROUPING SETS ((),(label))
      ), page AS (
        SELECT * FROM totals WHERE NOT overall
          ${query.afterViews!==undefined?sql`AND (views < ${query.afterViews} OR (views = ${query.afterViews} AND label > ${query.afterLabel}))`:sql``}
        ORDER BY views DESC,label LIMIT 26
      )
      SELECT * FROM totals WHERE overall UNION ALL SELECT * FROM page ORDER BY overall DESC,views DESC,label`);
    const [total,...ranked]=results;
    const rows=ranked.slice(0,25).map(({label,views,visitors})=>({label,views,visitors}));
    const last=rows.at(-1);
    return {...empty,pageviews:total.views,visitors:total.visitors,rows,
      next:ranked.length>25&&last?{afterViews:last.views,afterLabel:last.label,through}:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export function readAttribution(db:Db,actor:RecordAccessActor,query:AttributionQuery,includeBody:boolean){
  const actorId=actor.userId;
  return db.transaction(async tx=>{
    const owned=await ownedTrackingSites(tx,actorId);
    if(query.siteId&&!owned.some(s=>s.id===query.siteId))throw unavailable();
    const [workspace]=await tx.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(eq(privateWorkspaces.ownerId,actorId));
    const [contact]=query.contactId&&workspace?await tx.select({id:contacts.id,name:sql<string>`${contacts.data}->>'name'`}).from(contacts)
      .where(and(eq(contacts.workspaceId,workspace.id),eq(contacts.id,query.contactId),activeContact)):[];
    if(query.contactId&&!contact)throw unavailable();
    if(includeBody&&contact&&workspace)await recordAccess(tx,actor,'contacts','related',[contact.id],workspace.id);
    const empty={sites:owned,contact:contact??null,pageviews:contact?null:0,conversions:0,sources:[] as Source[],mediums:[] as Credit[],campaigns:[] as Credit[],recent:[] as Conversion[],next:null as {beforeAt:number;beforeId:string;through:number}|null,selected:null as (Conversion&{contactId:string|null})|null,path:[] as JourneyTouch[],pathTotal:0};
    if(!workspace||!owned.length){if(query.inquiryId)throw unavailable();return empty;}
    const [{at}]=await tx.select({at:clock}).from(sql`(VALUES(1)) AS now(n)`);
    const through=Math.min(query.through??at,at);
    const range=reportingWindow(at,query.period,through);
    const [pageviews]=contact?[]:await tx.select({total:count()}).from(visits).innerJoin(sites,eq(sites.id,visits.siteId))
      .where(and(eq(sites.workspaceId,workspace.id),query.siteId?eq(sites.id,query.siteId):undefined,gte(visits.at,range.start),lte(visits.at,range.end)));
    const liveInquiry=and(eq(leadInquiries.workspaceId,conversions.workspaceId),eq(leadInquiries.id,conversions.inquiryId),ne(leadInquiries.status,'removed'));
    const form=and(eq(leadForms.workspaceId,leadInquiries.workspaceId),eq(leadForms.id,leadInquiries.formId));
    const scope=and(eq(conversions.workspaceId,workspace.id),contact?eq(leadInquiries.contactId,contact.id):undefined,gte(conversions.convertedAt,range.start),lte(conversions.convertedAt,range.end),
      query.siteId?eq(conversions.siteId,query.siteId):undefined);
    const [total]=await tx.select({n:count()}).from(conversions).innerJoin(leadInquiries,liveInquiry).where(scope);
    const older=query.beforeAt===undefined?undefined:
      sql`(${conversions.convertedAt},${conversions.inquiryId}) < (${query.beforeAt}::bigint,${query.beforeId}::uuid)`;
    const page=await tx.select(attributionRow).from(conversions).innerJoin(leadInquiries,liveInquiry).innerJoin(leadForms,form)
      .where(and(scope,older)).orderBy(desc(conversions.convertedAt),desc(conversions.inquiryId)).limit(26);
    const recent=page.slice(0,25),last=recent.at(-1);
    const [detail]=query.inquiryId?await tx.select({...attributionRow,path:conversions.path,pathTotal:conversions.total,contactId:contacts.id}).from(conversions)
      .innerJoin(leadInquiries,liveInquiry).innerJoin(leadForms,form)
      .leftJoin(contacts,and(eq(contacts.workspaceId,leadInquiries.workspaceId),eq(contacts.id,leadInquiries.contactId),activeContact))
      .where(and(scope,eq(conversions.inquiryId,query.inquiryId))):[];
    if(query.inquiryId&&!detail)throw unavailable();
    if(includeBody&&detail?.contactId&&!contact)await recordAccess(tx,actor,'contacts','related',[detail.contactId],workspace.id);
    const rows=await tx.execute<Credit&{dimension:Dimension}>(sql`WITH credit AS (
      SELECT groups.dimension,coalesce(nullif(shares.key,''),${untagged}) AS label,
        count(*) FILTER (WHERE groups.first_touch=shares.key)::int AS first,
        count(*) FILTER (WHERE groups.last_touch=shares.key)::int AS last,
        sum(shares.value::numeric/${conversions.total}) AS linear
      FROM ${conversions} JOIN ${leadInquiries} ON ${liveInquiry}
      CROSS JOIN LATERAL (VALUES
        ('source',${conversions.firstSource},${conversions.lastSource},${conversions.counts}),
        ('medium',${conversions.path}->0->>'medium',${conversions.path}->-1->>'medium',${dimensionCounts('medium')}),
        ('campaign',${conversions.path}->0->>'campaign',${conversions.path}->-1->>'campaign',${dimensionCounts('campaign')})
      ) groups(dimension,first_touch,last_touch,counts)
      CROSS JOIN LATERAL jsonb_each_text(groups.counts) shares WHERE ${scope}
      GROUP BY 1,2
    ), ranked AS (SELECT *,row_number() OVER (PARTITION BY dimension,(label=${unknownVisits}) ORDER BY linear DESC,label) AS rank FROM credit)
    SELECT dimension,CASE WHEN rank>100 THEN 'Other (combined)' ELSE label END AS label,
      sum(first)::int AS first,sum(last)::int AS last,sum(linear)::float8 AS linear FROM ranked
    GROUP BY 1,2 ORDER BY dimension,linear DESC,label`);
    const credits=(dimension:Dimension)=>rows.filter(row=>row.dimension===dimension)
      .map(({label,first,last,linear})=>({label,first,last,linear}));
    return {...empty,pageviews:pageviews?.total??null,conversions:total.n,
      sources:credits('source').map(({label,...values})=>({source:label,...values})),
      mediums:credits('medium'),campaigns:credits('campaign'),recent,
      next:page.length>25&&last?{beforeAt:last.convertedAt,beforeId:last.inquiryId,through}:null,
      selected:detail?{contactId:detail.contactId,inquiryId:detail.inquiryId,siteId:detail.siteId,convertedAt:detail.convertedAt,formId:detail.formId,formTitle:detail.formTitle}:null,
      path:detail?.path??[],pathTotal:detail?.pathTotal??0};
  },{isolationLevel:'repeatable read',accessMode:includeBody&&(query.inquiryId||query.contactId)?'read write':'read only'});
}
