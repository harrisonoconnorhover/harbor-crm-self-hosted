import {effectiveMemberToolPolicy} from '../../lib/portable-tool-permissions';
import {and,asc,eq,sql,type SQL,type SQLWrapper} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {defaultRoutingRule,type LeadDistribution,type LeadRoutingMember,type LeadRoutingRule,type LeadRoutingPreview,type RoutingCounts,type RoutingReason} from '../../lib/portable-lead-routing';
import {loginIdentities} from './identity-schema';
import {workspaceViewers as members} from './workspace-viewer-schema';
import {privateWorkspaces} from './workspace-schema';
import {activeLead,leadRoutingMembers as rules,portableLeads as leads} from './portable-lead-schema';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {activeCompany} from './company-visibility';
import {activeContact} from './contact-visibility';
import {teamOffers} from './portable-meeting-schema';
import {bookedTeamTime} from './team-booking-store';
import {assigneeLabel,canWorkLead} from './workspace-assignee-store';
import {recordAccess,type RecordAccessActor} from './record-access-store';
import {sharedWorkspaceGrant} from './workspace-viewer-store';
import {readOwnedWorkspaceId,lockRecordWorkspace} from './private-workspace-store';

type Tx=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
const eligible=and(eq(members.role,'editor'),canWorkLead);
const memberRule=and(eq(members.workspaceId,rules.workspaceId),eq(members.viewerId,rules.userId));

const hasLeadAssignee=sql`EXISTS (SELECT 1 FROM ${privateWorkspaces}
  WHERE ${privateWorkspaces.id}=${leads.workspaceId} AND ${privateWorkspaces.ownerId}=${leads.assigneeId})
  OR EXISTS (SELECT 1 FROM ${members} WHERE ${members.workspaceId}=${leads.workspaceId}
    AND ${members.viewerId}=${leads.assigneeId} AND ${members.role}='editor' AND ${canWorkLead})`;

// Recheck the current grant at routing time. Losing access leaves the previous assignment in history.
export const leadNeedsRouting=sql<boolean>`(${leads.dealId} IS NULL
  AND ${leads.data}->>'leadStage' NOT IN ('Qualified','Disqualified')
  AND (${leads.assigneeId} IS NULL OR NOT (${hasLeadAssignee})))`;

export async function readLeadRouting(db:PostgresJsDatabase,ownerId:string):Promise<{members:LeadRoutingMember[];distribution:LeadDistribution;byCapacity:boolean}>{
  const rows=await db.select({memberId:members.id,name:loginIdentities.fullName,email:loginIdentities.email,rule:rules,
    byCapacity:privateWorkspaces.balanceLeadsByCapacity,roundRobin:privateWorkspaces.roundRobinLeads})
    .from(privateWorkspaces).leftJoin(members,and(eq(privateWorkspaces.id,members.workspaceId),eligible))
    .leftJoin(loginIdentities,eq(loginIdentities.id,members.viewerId)).leftJoin(rules,memberRule)
    .where(eq(privateWorkspaces.ownerId,ownerId)).orderBy(asc(loginIdentities.email));
  const reps=rows.flatMap(({memberId,name,email,rule})=>{
    if(!memberId||!email)return [];
    const {available,awayThrough,country,additionalCountries,regions,capacity,timeZone,days,start,end}=rule??defaultRoutingRule;
    return [{memberId,label:assigneeLabel({name,email}),revision:rule?.revision??0,available,awayThrough,country,additionalCountries,regions,capacity,timeZone,days,start,end}];
  });
  const byCapacity=rows[0]?.byCapacity??false;
  return {members:reps,byCapacity,distribution:rows[0]?.roundRobin?'round_robin':byCapacity?'capacity':'count'};
}

export async function saveLeadBalance(db:PostgresJsDatabase,ownerId:string,distribution:LeadDistribution){
  const [row]=await db.update(privateWorkspaces).set({balanceLeadsByCapacity:distribution==='capacity',roundRobinLeads:distribution==='round_robin'})
    .where(eq(privateWorkspaces.ownerId,ownerId)).returning({byCapacity:privateWorkspaces.balanceLeadsByCapacity});
  if(!row)throw new ApiError(404,'Workspace unavailable.');
  return {...row,distribution};
}

export function saveLeadRouting(db:PostgresJsDatabase,ownerId:string,input:LeadRoutingRule){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,ownerId,false,undefined,undefined,true);
    if(!workspaceId)throw new ApiError(404,'Workspace unavailable.');
    const [member]=await tx.select({userId:members.viewerId}).from(members)
      .where(and(eq(members.workspaceId,workspaceId),eq(members.id,input.memberId),eligible)).for('share');
    if(!member)throw new ApiError(409,'This teammate is no longer eligible. Reload the routing settings.');
    const {revision,available,country,capacity,timeZone,days,start,end}=input;
    const valid=await tx.execute(sql`SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=${timeZone} LIMIT 1`);
    if(!valid.length)throw new ApiError(400,'Choose a valid time zone, such as America/New_York.');
    const scope=and(eq(rules.workspaceId,workspaceId),eq(rules.userId,member.userId));
    const [before]=await tx.select({revision:rules.revision,country:rules.country,additionalCountries:rules.additionalCountries}).from(rules).where(scope);
    if((before?.revision??0)!==revision)throw new ApiError(409,'Routing settings changed. Reload them before saving.');
    // A legacy request that only adjusts hours or capacity keeps its saved territory.
    const additionalCountries=input.additionalCountries??(before?.country===country?undefined:[]);
    if(input.regions?.length&&(additionalCountries??before?.additionalCountries)?.length)
      throw new ApiError(400,'Choose one country for a state or province territory.');
    const regions=input.regions??(before?.country===country&&!additionalCountries?.length?undefined:[]);
    const values={available,awayThrough:input.awayThrough,country,additionalCountries,regions,capacity,timeZone,days,start,end,revision:revision+1};
    if(before)await tx.update(rules).set(values).where(scope);
    else await tx.insert(rules).values({workspaceId,userId:member.userId,...values});
    return {revision:values.revision};
  });
}

// The dispatcher only needs to count to capacity. The owner's preview looks one further to detect overflow.
function openRepLeads(workspace:SQLWrapper,rep:SQLWrapper,limit:SQLWrapper){
  return sql`SELECT 1 FROM ${leads} WHERE ${leads.archivedAt} IS NULL AND ${leads.workspaceId}=${workspace}
    AND ${leads.assigneeId}=${rep} AND ${leads.dealId} IS NULL AND ${leads.data}->>'leadStage' NOT IN ('Qualified','Disqualified')
    LIMIT ${limit}`;
}

export async function readRepWorkload(db:PostgresJsDatabase,ownerId:string,grantId:string){
  const capacity=sql<number>`coalesce(${rules.capacity},${defaultRoutingRule.capacity})`;
  const open=openRepLeads(members.workspaceId,members.viewerId,sql`(${capacity}+1)`);
  const [row]=await db.select({capacity,count:sql<number>`(SELECT count(*)::int FROM (${open}) open_leads)`})
    .from(members).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,members.workspaceId)).leftJoin(rules,memberRule)
    .where(and(eq(privateWorkspaces.ownerId,ownerId),eq(members.id,grantId),eligible));
  if(!row)throw new ApiError(404,'Rep unavailable. Reload the routing pool.');
  return {capacity:row.capacity,openLeads:row.count>row.capacity?null:row.count};
}

function routingPool(workspaceId:string,companyId:string|null,contactId:string|null,submittedCountry?:string,submittedRegion?:string,previewAt?:string){
  const instant=previewAt?sql`${previewAt}::timestamptz`:sql`statement_timestamp()`;
  const companyCountry=sql`nullif(btrim(${companies.data}->>'country'),'')`;
  const contactCountry=sql`nullif(btrim(${contacts.data}->>'country'),'')`;
  const from=sql`FROM ${rules} JOIN ${members} ON ${memberRule}
    LEFT JOIN ${companies} ON ${companies.workspaceId}=${rules.workspaceId} AND ${companies.id}=${companyId} AND ${activeCompany}
    LEFT JOIN ${contacts} ON ${contacts.workspaceId}=${rules.workspaceId} AND ${contacts.id}=${contactId} AND ${activeContact}
    CROSS JOIN LATERAL (SELECT lower(coalesce(${companyCountry},${contactCountry},${submittedCountry??null}::text)) AS country,
      lower(btrim(CASE WHEN ${companyCountry} IS NOT NULL THEN ${companies.data}->>'state'
        WHEN ${contactCountry} IS NOT NULL THEN ${contacts.data}->>'state' ELSE ${submittedRegion??null}::text END)) AS region) address
    JOIN ${privateWorkspaces} ON ${privateWorkspaces.id}=${rules.workspaceId}
    LEFT JOIN ${teamOffers} ON ${teamOffers.workspaceId}=${rules.workspaceId} AND ${teamOffers.userId}=${rules.userId}
      AND ${teamOffers.grantId}=${members.id}
    CROSS JOIN LATERAL (SELECT ${instant} AT TIME ZONE ${rules.timeZone} AS local_time,
      floor(extract(epoch FROM ${instant})*1000)::bigint AS at_ms) clock
    CROSS JOIN LATERAL (SELECT count(*) AS open_count FROM (${openRepLeads(rules.workspaceId,rules.userId,rules.capacity)}) open_leads) workload`;
  const scope=and(eq(rules.workspaceId,workspaceId),eligible);
  const minute=sql`(extract(hour FROM clock.local_time)::int*60+extract(minute FROM clock.local_time)::int)`;
  const overnight=sql`${rules.start}>${rules.end}`;
  // The early hours of an overnight shift belong to the previous local weekday.
  const shiftDate=sql`(clock.local_time::date - CASE WHEN ${overnight} AND ${minute}<${rules.end} THEN 1 ELSE 0 END)`;
  const duringShift=sql`CASE WHEN ${overnight} THEN ${minute}>=${rules.start} OR ${minute}<${rules.end}
    ELSE ${minute}>=${rules.start} AND ${minute}<${rules.end} END`;
  const checks:{reason:Exclude<RoutingReason,'ready'>;allowed:SQL}[]=[
    {reason:'paused',allowed:sql`${rules.available}`},
    {reason:'territory',allowed:sql`(${rules.country}='' OR EXISTS (
      SELECT 1 FROM unnest(array_prepend(${rules.country}::varchar,${rules.additionalCountries})) AS territory(country)
      WHERE lower(territory.country)=address.country)) AND
      (cardinality(${rules.regions})=0 OR EXISTS (SELECT FROM unnest(${rules.regions}) region(name) WHERE lower(region.name)=address.region))`},
    {reason:'away',allowed:sql`(${rules.awayThrough} IS NULL OR ${rules.awayThrough}<${shiftDate})`},
    {reason:'timeOff',allowed:sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${teamOffers.timeOff}) period
      WHERE period->>'pauseLeadRouting'='true' AND (period->>'startMs')::bigint<=clock.at_ms
        AND clock.at_ms<(period->>'endMs')::bigint)`},
    {reason:'hours',allowed:sql`((${rules.days} & (1 << (extract(isodow FROM ${shiftDate})::int-1)))<>0 AND (${duringShift}))`},
    {reason:'meeting',allowed:sql`NOT ${bookedTeamTime(sql`${rules.userId}`,sql`clock.at_ms`,sql`clock.at_ms+1`,workspaceId)}`},
    {reason:'capacity',allowed:sql`workload.open_count<${rules.capacity}`},
  ];
  const order=sql`(cardinality(${rules.regions})>0) DESC, (${rules.country}<>'') DESC, CASE WHEN ${privateWorkspaces.roundRobinLeads} THEN 0 WHEN ${privateWorkspaces.balanceLeadsByCapacity}
    THEN workload.open_count::numeric / ${rules.capacity} ELSE workload.open_count END, ${rules.lastAssignedAt} NULLS FIRST, ${rules.userId}`;
  return {from,scope,checks,order};
}

// The caller holds the workspace write lock through the lead insert and its history entry.
export async function routeNewLead(tx:Tx,workspaceId:string,companyId:string|null,contactId:string|null,submittedCountry?:string,submittedRegion?:string){
  const pool=routingPool(workspaceId,companyId,contactId,submittedCountry,submittedRegion);
  const [choice]=await tx.execute<{user_id:string}>(sql`SELECT ${rules.userId} AS user_id ${pool.from}
    WHERE ${pool.scope} AND ${sql.join(pool.checks.map(check=>check.allowed),sql` AND `)}
    ORDER BY ${pool.order} LIMIT 1`);
  if(!choice)return null;
  await recordRoutingTurn(tx,workspaceId,choice.user_id);
  return choice.user_id;
}

export async function recordRoutingTurn(tx:Tx,workspaceId:string,userId:string){
  await tx.update(rules).set({lastAssignedAt:sql`clock_timestamp()`})
    .where(and(eq(rules.workspaceId,workspaceId),eq(rules.userId,userId)));
}

// Classify each configured rep once. The decision and its explanation use one snapshot.
export async function assessLeadRouting(tx:Tx,workspaceId:string,companyId:string|null,contactId:string|null,country?:string,region?:string,previewAt?:string){
  const pool=routingPool(workspaceId,companyId,contactId,country,region,previewAt);
  const reason=sql`CASE ${sql.join(pool.checks.map(check=>sql`WHEN (${check.allowed}) IS NOT TRUE THEN ${check.reason}::text`),sql` `)} ELSE 'ready' END`;
  const rows=await tx.execute<{reason:RoutingReason;n:number;user_id:string;name:string|null;email:string}>(sql`
    WITH candidates AS (SELECT ${reason} AS reason,${rules.userId} AS user_id,
      row_number() OVER (ORDER BY ${pool.order}) AS position ${pool.from} WHERE ${pool.scope}),
    counts AS (SELECT DISTINCT ON (reason) reason,count(*) OVER (PARTITION BY reason)::int AS n,user_id
      FROM candidates ORDER BY reason,position)
    SELECT counts.*, ${loginIdentities.fullName} AS name,${loginIdentities.email} AS email FROM counts
      JOIN ${loginIdentities} ON ${loginIdentities.id}=counts.user_id`);
  const counts:RoutingCounts={};
  for(const row of rows)counts[row.reason]=row.n;
  return {counts,winner:rows.find(row=>row.reason==='ready')};
}

function routingPreview({counts,winner}:Awaited<ReturnType<typeof assessLeadRouting>>):LeadRoutingPreview{
  return {counts,next:winner?assigneeLabel(winner):null};
}

export function previewTerritoryRouting(db:PostgresJsDatabase,ownerId:string,country?:string,region?:string,previewAt?:string){
  return db.transaction(async tx=>{
    const workspaceId=await readOwnedWorkspaceId(tx,ownerId);
    if(!workspaceId)return {counts:{},next:null};
    return routingPreview(await assessLeadRouting(tx,workspaceId,null,null,country,region,previewAt));
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export function previewLeadRouting(db:PostgresJsDatabase,actor:RecordAccessActor,id:string,shared?:string,includeBody=true){
  return db.transaction(async tx=>{
    const workspace=shared??await readOwnedWorkspaceId(tx,actor.userId);
    if(shared){
      const grant=await sharedWorkspaceGrant(tx,actor.userId,shared,true);
      if(!grant||effectiveMemberToolPolicy(grant,'leads').edit!=='all')throw new ApiError(403,'Workspace-wide editing access is required to preview routing.');
    }
    if(!workspace)throw new ApiError(404,'Lead unavailable.');
    const [lead]=await tx.select({company:leads.companyId,contact:leads.contactId,country:leads.intakeCountry,region:leads.intakeRegion,
      needsRouting:leadNeedsRouting,lastMiss:leads.routingMiss}).from(leads)
      .where(and(eq(leads.workspaceId,workspace),eq(leads.id,id),activeLead));
    if(!lead)throw new ApiError(404,'Lead unavailable.');
    if(!lead.needsRouting)throw new ApiError(409,'Choose an open lead that needs routing.');
    const assessment=await assessLeadRouting(tx,workspace,lead.company,lead.contact,lead.country??undefined,lead.region??undefined);
    const result=routingPreview(assessment);
    if(lead.lastMiss)result.lastMiss=lead.lastMiss;
    if(includeBody)await recordAccess(tx,actor,'leads','related',[id],workspace);
    return result;
  },{isolationLevel:'repeatable read'});
}
