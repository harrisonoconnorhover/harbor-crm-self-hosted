import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {activeDeal} from './deal-visibility';
import {and,asc,eq,gt,isNull,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portableReportGroupLimit,type PortableReportDefinition,type PortableReportMutation,type PortableReportPage,
  type PortableReportRead,type PortableReportResult,type PortableSavedReport} from '../../lib/portable-reports';
import {companies} from './company-schema';
import {portableCustomProperties} from './custom-property-schema';
import {contacts} from './contact-schema';
import {dealPipelineStages} from './deal-pipeline-schema';
import {dealPipelineScope,deals} from './deal-schema';
import {portableLeads} from './portable-lead-schema';
import {portableReports as reports} from './portable-report-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {activeTask,portableTasks} from './task-schema';
import {portableTickets} from './ticket-schema';
import {privateWorkspaces} from './workspace-schema';
import {recordWorkspaceScope} from './workspace-viewer-store';

const fields={id:reports.id,revision:reports.revision,definition:reports.definition,updatedAt:reports.updatedAt};
export async function readPortableReports(db:PostgresJsDatabase,actorId:string,query:PortableReportRead):Promise<PortableReportPage|PortableSavedReport|null>{
  const selection=db.select(fields).from(reports)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,reports.workspaceId));
  const scope=eq(privateWorkspaces.ownerId,actorId);
  if('id' in query){
    const [item]=await selection.where(and(scope,eq(reports.id,query.id))).limit(1);
    return item??null;
  }
  const titleMatch=query.search?sql`strpos(lower((${reports.definition}->>'name') COLLATE pg_catalog.pg_unicode_fast),
    lower(${query.search}::text COLLATE pg_catalog.pg_unicode_fast))>0`:undefined;
  const rows=await selection.where(and(scope,titleMatch,query.after?gt(reports.id,query.after):undefined))
    .orderBy(asc(reports.id)).limit(query.limit+1);
  const items=rows.slice(0,query.limit);
  return {items,next:rows.length>query.limit?items.at(-1)!.id:null};
}

type MutationResult={item:PortableSavedReport}|{deleted:true}|{error:'missing'|'stale'};
export function writePortableReport(db:PostgresJsDatabase,actorId:string,input:PortableReportMutation):Promise<MutationResult>{
  return db.transaction(async tx=>{
    const creating=!('id' in input);
    const workspaceId=await lockRecordWorkspace(tx,actorId,creating);
    if(!workspaceId)return {error:'missing'};
    if('id' in input){
      const scope=and(eq(reports.workspaceId,workspaceId),eq(reports.id,input.id));
      const [current]=await tx.select({revision:reports.revision}).from(reports).where(scope).for('update');
      if(!current)return {error:'missing'};
      if(current.revision!==input.revision)return {error:'stale'};
      if(input.action==='deleteReport'){
        await tx.delete(reports).where(scope);
        return {deleted:true};
      }
      const [item]=await tx.update(reports).set({definition:input.definition,revision:input.revision+1,updatedAt:new Date().toISOString()})
        .where(scope).returning(fields);
      return {item};
    }
    const [item]=await tx.insert(reports).values({workspaceId,id:crypto.randomUUID(),revision:1,definition:input.definition,
      updatedAt:new Date().toISOString()}).returning(fields);
    return {item};
  });
}

const sources={contacts,companies,deals,tasks:portableTasks,leads:portableLeads,tickets:portableTickets};

// Compare against the property's stored type. A deleted property matches nothing.
async function customCondition(db:PostgresJsDatabase,actorId:string,d:PortableReportDefinition,workspaceId?:string){
  const filter=d.customFilter;
  if(!filter||!(d.kind==='contacts'||d.kind==='companies'||d.kind==='deals'))return undefined;
  const [definition]=await db.select({type:portableCustomProperties.type}).from(portableCustomProperties)
    .innerJoin(privateWorkspaces,eq(privateWorkspaces.id,portableCustomProperties.workspaceId))
    .where(and(recordWorkspaceScope(db,actorId,workspaceId),eq(portableCustomProperties.kind,d.kind),eq(portableCustomProperties.id,filter.propertyId)));
  if(!definition)return sql`false`;
  // Cast the key so Postgres picks the text-key operator rather than the array-index one.
  const key=sql`${filter.propertyId}::text`,table=sources[d.kind],raw=sql`(${table.data}->'custom'->${key})`,text=sql`(${table.data}->'custom'->>${key})`;
  const known=definition.type==='multiselect'?sql`jsonb_typeof(${raw})='array' AND jsonb_array_length(${raw})>0`:
    definition.type==='checkbox'?sql`${raw}='true'::jsonb`:sql`coalesce(${text},'')<>''`;
  if(filter.operator==='known')return known;
  if(filter.operator==='unknown')return sql`NOT coalesce(${known},false)`;
  const value=filter.value!;
  if(definition.type==='number'){
    if(typeof value!=='number'||filter.operator!=='is')return sql`false`;
    return sql`jsonb_typeof(${raw})='number' AND (${text})::numeric=${value}::numeric`;
  }
  if(definition.type==='checkbox'){
    if(typeof value!=='boolean'||filter.operator!=='is')return sql`false`;
    return value?sql`${raw}='true'::jsonb`:sql`${raw} IS DISTINCT FROM 'true'::jsonb`;
  }
  if(definition.type==='multiselect')return sql`jsonb_typeof(${raw})='array' AND ${raw} ? ${String(value)}::text`;
  const lowered=String(value).toLowerCase();
  return filter.operator==='contains'?sql`strpos(lower(${text}),${lowered})>0`:sql`lower(${text})=${lowered}`;
}
async function reportPopulation(db:PostgresJsDatabase,actorId:string,d:PortableReportDefinition,workspaceId?:string){
  const table=sources[d.kind];
  const byDealStage=d.kind==='deals'&&d.groupBy==='stage';
  const stageKey=sql`coalesce(${deals.pipelineId}::text||':'||${deals.stageId}::text,${deals.data}->>'stage')`;
  const dimension=byDealStage?stageKey:d.groupBy?sql`nullif(${table.data}->>${d.groupBy},'')`:sql`null::text`;
  const label=byDealStage?sql`coalesce(${dealPipelineStages.name},${deals.data}->>'stage')`:dimension;
  const stagesJoin=byDealStage||d.dealOutcome?sql`LEFT JOIN ${dealPipelineStages} ON ${dealPipelineStages.workspaceId}=${deals.workspaceId}
    AND ${dealPipelineStages.pipelineId}=${deals.pipelineId} AND ${dealPipelineStages.id}=${deals.stageId}`:sql``;
  const amount=d.metric==='sum'?sql`CASE WHEN jsonb_typeof(${deals.data}->'amount')='number' THEN (${deals.data}->>'amount')::numeric END`:sql`null::numeric`;
  const filter=d.filter;
  const field=filter?sql`${table.data}->>${filter.field}`:undefined;
  const condition=filter&&field?filter.operator==='between'
    ?sql`(${field}) COLLATE "C" BETWEEN ${filter.value} AND ${filter.valueTo}`
    :sql`lower((${field}) COLLATE "C")=${filter.value.toLowerCase()}`:undefined;
  const priority=d.ticketPriority?sql`${portableTickets.data}->>'ticketPriority'=${d.ticketPriority}`:undefined;
  const ticketSource=d.ticketSource?sql`${portableTickets.data}->>'ticketSource'=${d.ticketSource}`:undefined;
  const ticketCategory=d.ticketCategory?sql`${portableTickets.data}->>'ticketCategory'=${d.ticketCategory}`:undefined;
  const outcome=d.dealOutcome?sql`coalesce(${dealPipelineStages.outcome}, CASE ${deals.data}->>'stage'
    WHEN 'Closed won' THEN 'won' WHEN 'Closed lost' THEN 'lost' ELSE 'open' END)=${d.dealOutcome}`:undefined;
  const dates=d.createdDateRange;
  const created=dates?sql`${table.createdAt}>=(${dates.from}::date::timestamp AT TIME ZONE 'UTC')
    AND ${table.createdAt}<((${dates.through}::date+1)::timestamp AT TIME ZONE 'UTC')`:undefined;
  const dueDates=d.taskDueDateRange;
  const due=dueDates?sql`(${portableTasks.data}->>'dueDate') COLLATE "C" BETWEEN ${dueDates.from} AND ${dueDates.through}`:undefined;
  const assignee=d.taskAssigneeId===null?isNull(portableTasks.assigneeId):
    d.taskAssigneeId===undefined?undefined:eq(portableTasks.assigneeId,d.taskAssigneeId);
  const stage=d.dealStageId?(d.dealPipelineId==='default'?sql`${deals.data}->>'stage'=${d.dealStageId}`:
    eq(deals.stageId,d.dealStageId)):undefined;
  const custom=await customCondition(db,actorId,d,workspaceId);
  const scope=and(recordWorkspaceScope(db,actorId,workspaceId),custom,d.kind==='contacts'?activeContact:d.kind==='companies'?activeCompany:d.kind==='deals'?activeDeal:d.kind==='tasks'?activeTask:undefined,
    condition,priority,ticketSource,ticketCategory,outcome,created,due,assignee,stage,d.dealPipelineId?dealPipelineScope(d.dealPipelineId):undefined);
  return sql`SELECT ${table.id} AS id,coalesce(nullif(${table.data}->>'name',''),'Untitled') AS name,
    ${dimension} AS group_key,coalesce(${label},'No value') AS group_label,${amount} AS amount
    FROM ${table} INNER JOIN ${privateWorkspaces} ON ${privateWorkspaces.id}=${table.workspaceId}
    ${stagesJoin} WHERE ${scope}`;
}

export async function evaluatePortableReport(db:PostgresJsDatabase,actorId:string,d:PortableReportDefinition,groupLimit=portableReportGroupLimit,
  workspaceId?:string):Promise<PortableReportResult>{
  const population=await reportPopulation(db,actorId,d,workspaceId);
  const aggregate=d.metric==='sum'?sql`sum(amount)`:sql`count(*)`;
  const sort=d.sort==='label'?sql``:d.sort==='value-asc'?sql`${aggregate} ASC NULLS LAST,`:sql`${aggregate} DESC NULLS LAST,`;
  // This query aggregates the full authorized population in Postgres. The
  // limit caps response groups only, with the grand total in the same snapshot.
  const [total,...groups]=await db.execute<{key:string|null;label:string;count:string;value:string|null}>(sql`
    WITH population AS (${population})
    SELECT group_key AS key,group_label AS label,count(*)::text AS count,${aggregate}::text AS value
    FROM population GROUP BY GROUPING SETS ((group_key,group_label),())
    HAVING GROUPING(group_key)=1 OR ${!!d.groupBy}
    ORDER BY GROUPING(group_key) DESC,${sort}lower(group_label) COLLATE "C",group_label COLLATE "C",group_key COLLATE "C"
    LIMIT ${groupLimit+2}
  `);
  return {total:total.value,count:total.count,rows:groups.slice(0,groupLimit),truncated:groups.length>groupLimit};
}

export async function readPortableReportRecords(db:PostgresJsDatabase,actorId:string,definition:PortableReportDefinition,
  {workspaceId,after,group}:{workspaceId?:string;after?:string;group?:string}){
  const population=await reportPopulation(db,actorId,definition,workspaceId);
  const filter=and(after?sql`id>${after}::uuid`:undefined,
    group===undefined?undefined:group===''?sql`group_key IS NULL`:sql`group_key=${group}`);
  const records=await db.execute<{id:string;name:string}>(sql`WITH population AS (${population})
    SELECT id,name FROM population ${filter?sql`WHERE ${filter}`:sql``} ORDER BY id LIMIT 26`);
  const page=records.slice(0,25);
  return {kind:definition.kind,records:page,next:records.length>page.length?page.at(-1)!.id:null};
}
