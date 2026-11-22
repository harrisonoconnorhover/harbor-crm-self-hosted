import {allToolViews} from './member-tool-access';
import {indexedRecordValues,literalSearchPattern,recordSearchCandidate,recordValueContains} from './search-index';
import {visibleRecordData} from './record-property-access';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {activeDeal} from './deal-visibility';
import {and,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {z} from 'zod';
import {kinds} from '../../lib/crm';
import type {PortableSearchCursor,PortableSearchPage,PortableSearchResult,portableSearchInput} from '../../lib/crm-search';
import {companies} from './company-schema';
import {customRecordMatches} from './custom-object-search';
import {objectRecords,objectTypes} from './custom-object-schema';
import {contacts} from './contact-schema';
import {deals} from './deal-schema';
import {activeLead,leadOwnership,portableLeads} from './portable-lead-schema';
import {activeTask,taskOwnership,portableTasks} from './task-schema';
import {activeTicket,portableTickets,ticketOwnership} from './ticket-schema';
import {privateWorkspaces} from './workspace-schema';
import {ownedRecordScope} from './record-ownership-scope';
import {workspaceViewers} from './workspace-viewer-schema';
import {recordWorkspaceScope,sharedWorkspaceGrant} from './workspace-viewer-store';

const tables={contacts,companies,deals,leads:portableLeads,tasks:portableTasks,tickets:portableTickets};
const size=8;

export async function searchPortableCrm(db:PostgresJsDatabase,actorId:string,input:z.infer<typeof portableSearchInput>,workspaceId?:string):Promise<PortableSearchPage|null>{
  const counts:PortableSearchPage['counts']={'custom-objects':0,contacts:0,companies:0,deals:0,tasks:0,leads:0,tickets:0};
  if(!input.query){
    if(workspaceId&&!await sharedWorkspaceGrant(db,actorId,workspaceId,true))return null;
    return {counts,total:0,page:0,start:0,size,results:[],next:null,previous:null};
  }

  // Apply selective index conditions first. The final comparison checks every term against visible values.
  const words=input.match==='words'?[...new Set(input.query.split(/\s+/u).filter(Boolean))]:[];
  const multiple=words.length>1;
  const phrase=words.length===1?words[0]:input.query;
  const probes=multiple?words.filter(word=>/[\p{L}\p{N}]{3}/u.test(word)).sort((a,b)=>b.length-a.length).slice(0,3):[];
  const patterns=multiple?sql`ARRAY(SELECT lower(pattern COLLATE pg_catalog.pg_unicode_fast) COLLATE "C"
    FROM jsonb_array_elements_text(${JSON.stringify(words.map(literalSearchPattern))}::jsonb) AS terms(pattern))`:null;
  const objects=kinds.map(kind=>{
    const table=tables[kind];
    const core=kind==='contacts'||kind==='companies'||kind==='deals';
    const data=workspaceId&&core?visibleRecordData(table.data,workspaceId,kind,actorId):table.data;
    const visibility=workspaceId?sql`(search_workspace.full_access OR ${ownedRecordScope(db,actorId,workspaceId,kind==='leads'?leadOwnership:kind==='tasks'?taskOwnership:kind==='tickets'?ticketOwnership:table)})`:sql`search_workspace.full_access`;
    const match=patterns?and(...probes.map(word=>recordSearchCandidate(table.data,word)),sql`${indexedRecordValues(data)} LIKE ALL (${patterns})`):
      and(recordSearchCandidate(table.data,phrase),recordValueContains(data,phrase));
    return sql`SELECT ${kind}::text AS kind, ${table.id} AS id, NULL::uuid AS "objectId",
      coalesce(nullif(${table.data}->>'name',''),'Untitled') AS name,
      coalesce(nullif(${table.data}->>'email',''),${table.data}->>'domain','') AS detail
      FROM ${table} JOIN search_workspace ON search_workspace.id=${table.workspaceId}
      WHERE ${match}
        AND ${visibility} AND ${kind==='contacts'?activeContact:kind==='companies'?activeCompany:kind==='deals'?activeDeal:kind==='tasks'?activeTask:kind==='leads'?activeLead:activeTicket}`;
  });
  const customVisibility=workspaceId?sql`(search_workspace.full_access OR ${ownedRecordScope(db,actorId,workspaceId,objectRecords)})`:sql`true`;
  const customValues=sql`coalesce(${objectRecords.data}->'values','{}'::jsonb)`;
  const customMatch=multiple?and(...probes.map(customRecordMatches),sql`NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(${JSON.stringify(words.map(word=>[word,literalSearchPattern(word)]))}::jsonb) AS terms(term)
    WHERE NOT ( ${objectRecords.name} ILIKE (term->>1) OR
      ${indexedRecordValues(customValues)} LIKE (lower((term->>1) COLLATE pg_catalog.pg_unicode_fast) COLLATE "C") OR
      (lower(term->>0)='yes' AND ${customValues} @? '$.* ? (@ == true)') OR
      (lower(term->>0)='no' AND ${customValues} @? '$.* ? (@ == false)') )
  )`):customRecordMatches(phrase);
  objects.push(sql`SELECT 'custom-objects'::text AS kind, ${objectRecords.id} AS id, ${objectRecords.objectId} AS "objectId",
    ${objectRecords.name} AS name, ${objectTypes.definition}->>'name' AS detail
    FROM ${objectRecords} JOIN search_workspace ON search_workspace.id=${objectRecords.workspaceId}
    JOIN ${objectTypes} ON ${objectTypes.workspaceId}=${objectRecords.workspaceId} AND ${objectTypes.id}=${objectRecords.objectId}
    WHERE ${objectRecords.archivedAt} IS NULL AND ${customVisibility} AND ${customMatch}`);
  const workspace=workspaceId?sql`SELECT ${workspaceViewers.workspaceId} AS id, ${allToolViews} AS full_access
    FROM ${workspaceViewers} WHERE ${workspaceViewers.workspaceId}=${workspaceId} AND ${workspaceViewers.viewerId}=${actorId}`:
    sql`SELECT ${privateWorkspaces.id},true AS full_access FROM ${privateWorkspaces} WHERE ${recordWorkspaceScope(db,actorId)}`;
  const cursor=input.cursor,backward=cursor?.direction==='before';
  const keys=[sql`lower(name COLLATE pg_catalog.pg_unicode_fast)`,sql`id`,sql`kind`,sql`"objectId"`];
  // Only custom records share a kind and ID across object types. For core records,
  // a NULL final key compares neither greater nor less when the other keys are equal.
  const key=sql`(${sql.join(keys,sql`, `)})`;
  const boundary=cursor?sql`(lower(${cursor.name}::text COLLATE pg_catalog.pg_unicode_fast),${cursor.id}::uuid,
    ${cursor.kind}::text,${cursor.objectId??null}::uuid)`:null;
  const beyond=boundary?sql`${key} ${backward?sql`<`:sql`>`} ${boundary}`:undefined;
  const order=sql.join(keys.map(k=>backward?sql`${k} DESC`:k),sql`, `);
  const ascending=sql.join(keys,sql`, `);
  const selectedKind=sql`${input.kind??''} IN ('',kind)`;
  const start=cursor?(backward?sql`greatest(0,side_count-${size})`:sql`total-side_count`):
    sql`least(${input.page},greatest(0,(total-1)/${size}))*${size}`;
  const [row]=await db.execute<{authorized:boolean;counts:Partial<PortableSearchPage['counts']>;total:number;start:number;results:PortableSearchResult[]}>(sql`
    WITH search_workspace AS (${workspace}),
    matches AS (${sql.join(objects,sql` UNION ALL `)}),
    breakdown AS (SELECT kind,count(*)::int AS count
      ${beyond?sql`,count(*) FILTER (WHERE ${selectedKind} AND ${beyond}) AS side_count`:sql``}
      FROM matches GROUP BY kind),
    totals AS (SELECT coalesce(sum(count),0)::int AS total
      ${beyond?sql`,coalesce(sum(side_count),0)::int AS side_count`:sql``}
      FROM breakdown WHERE ${selectedKind}),
    bounds AS (SELECT total,${start} AS start FROM totals),
    selection AS (
      SELECT id,kind,name,detail,"objectId" FROM matches WHERE ${selectedKind}
        ${beyond?sql`AND ${beyond}`:sql``}
      ORDER BY ${order} LIMIT ${size} ${!cursor&&input.page?sql`OFFSET (SELECT start FROM bounds)`:sql``}
    )
    SELECT EXISTS (SELECT 1 FROM search_workspace) AS authorized,total,start,
      coalesce((SELECT jsonb_object_agg(kind,count) FROM breakdown),'{}'::jsonb) AS counts,
      coalesce((SELECT jsonb_agg(jsonb_strip_nulls(to_jsonb(selection)) ORDER BY ${ascending})
        FROM selection),'[]'::jsonb) AS results
    FROM bounds
  `);
  if(workspaceId&&!row.authorized)return null;
  function edge(record:PortableSearchResult,direction:PortableSearchCursor['direction']):PortableSearchCursor{
    return {direction,name:record.name,id:record.id,kind:record.kind,...(record.kind==='custom-objects'?{objectId:record.objectId}:{})};
  }
  const first=row.results[0],last=row.results.at(-1);
  return {counts:{...counts,...row.counts},total:row.total,page:Math.floor(row.start/size),start:row.start,size,results:row.results,
    previous:first&&row.start>0?edge(first,'before'):null,
    next:last&&row.start+row.results.length<row.total?edge(last,'after'):null};
}
