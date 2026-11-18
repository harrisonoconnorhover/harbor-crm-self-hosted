import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {activeDeal} from './deal-visibility';
import {sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {z} from 'zod';
import {kinds,type Kind} from '../../lib/crm';
import type {SearchPage,SearchResult,searchInput} from '../../lib/crm-search';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {deals} from './deal-schema';
import {portableLeads} from './portable-lead-schema';
import {activeTask,portableTasks} from './task-schema';
import {portableTickets} from './ticket-schema';
import {privateWorkspaces} from './workspace-schema';
import {recordWorkspaceScope,sharedWorkspaceGrant} from './workspace-viewer-store';

const tables={contacts,companies,deals,leads:portableLeads,tasks:portableTasks,tickets:portableTickets};
const size=8;

export async function searchPortableCrm(db:PostgresJsDatabase,actorId:string,input:z.infer<typeof searchInput>,workspaceId?:string):Promise<SearchPage|null>{
  const counts:SearchPage['counts']={contacts:0,companies:0,deals:0,tasks:0,leads:0,tickets:0};
  if(!input.query){
    if(workspaceId&&!await sharedWorkspaceGrant(db,actorId,workspaceId))return null;
    return {counts,total:0,page:0,size,results:[]};
  }

  const objects=kinds.map(kind=>{
    const table=tables[kind];
    return sql`SELECT ${kind}::text AS kind, ${table.id} AS id,
      coalesce(nullif(${table.data}->>'name',''),'Untitled') AS name,
      coalesce(nullif(${table.data}->>'email',''),${table.data}->>'domain','') AS detail
      FROM ${table} JOIN search_workspace ON search_workspace.id=${table.workspaceId}
      WHERE ${kind==='contacts'?activeContact:kind==='companies'?activeCompany:kind==='deals'?activeDeal:kind==='tasks'?activeTask:sql`true`} AND EXISTS (
        SELECT 1 FROM jsonb_path_query(${table.data},
          'strict $.** ? (@.type() != "object" && @.type() != "array" && @.type() != "null")') AS property(value)
        WHERE strpos(lower((property.value #>> '{}') COLLATE pg_catalog.pg_unicode_fast),
          lower(${input.query}::text COLLATE pg_catalog.pg_unicode_fast))>0
      )`;
  });
  const [row]=await db.execute<{authorized:boolean;counts:Partial<Record<Kind,number>>;total:number;page:number;results:SearchResult[]}>(sql`
    WITH search_workspace AS (SELECT ${privateWorkspaces.id} FROM ${privateWorkspaces} WHERE ${recordWorkspaceScope(db,actorId,workspaceId)}),
    matches AS (${sql.join(objects,sql` UNION ALL `)}),
    totals AS (SELECT count(*)::int AS total FROM matches WHERE ${input.kind??''} IN ('',kind)),
    bounds AS (SELECT total,least(${input.page},greatest(0,(total-1)/${size})) AS page FROM totals),
    selection AS (
      SELECT id,kind,name,detail FROM matches WHERE ${input.kind??''} IN ('',kind)
      ORDER BY lower(name COLLATE pg_catalog.pg_unicode_fast),id,kind LIMIT ${size} OFFSET (SELECT page*${size} FROM bounds)
    )
    SELECT EXISTS (SELECT 1 FROM search_workspace) AS authorized,total,page,
      coalesce((SELECT jsonb_object_agg(kind,count) FROM
        (SELECT kind,count(*)::int AS count FROM matches GROUP BY kind) AS by_kind),'{}'::jsonb) AS counts,
      coalesce((SELECT jsonb_agg(to_jsonb(selection) ORDER BY lower(name COLLATE pg_catalog.pg_unicode_fast),id,kind)
        FROM selection),'[]'::jsonb) AS results
    FROM bounds
  `);
  if(workspaceId&&!row.authorized)return null;
  return {counts:{...counts,...row.counts},total:row.total,page:row.page,size,results:row.results};
}
