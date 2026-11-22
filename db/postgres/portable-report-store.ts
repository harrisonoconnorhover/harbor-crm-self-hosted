import {recordAccess,type RecordAccessActor} from './record-access-store';
import {propertyVisibleTo} from './record-property-access';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {activeDeal} from './deal-visibility';
import {and,asc,eq,gt,isNotNull,isNull,or,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {isTeamReportGroup,portableReportGroupLimit,relatedCompanyGroup,type PortableReportDefinition,type PortableReportMutation,type PortableReportPage,
  type PortableReportRead,type PortableReportResult,type PortableSavedReport} from '../../lib/portable-reports';
import {companies} from './company-schema';
import {portableCustomProperties} from './custom-property-schema';
import {contacts} from './contact-schema';
import {dealPipelineStages} from './deal-pipeline-schema';
import {dealPipelineScope,deals} from './deal-schema';
import {activeLead,leadOwnership,portableLeads} from './portable-lead-schema';
import {portableReports as reports} from './portable-report-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {activeTask,taskOwnership,portableTasks} from './task-schema';
import {firstResponseConditions} from './ticket-first-response-store';
import {firstResponseOutcomes,firstResponseOutcomeLabels} from '../../lib/first-response';
import {activeTicket,portableTickets,responseReceipts,ticketOwnership} from './ticket-schema';
import {privateWorkspaces} from './workspace-schema';
import {sharedCoreRecordScope} from './record-ownership-scope';
import {workspaceTeams} from './workspace-team-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {recordCatalogScope,recordWorkspaceScope} from './workspace-viewer-store';

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
    .where(and(recordCatalogScope(db,actorId,workspaceId),eq(portableCustomProperties.kind,d.kind),eq(portableCustomProperties.id,filter.propertyId),workspaceId?propertyVisibleTo(actorId):undefined));
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
// Build the hierarchy once for this workspace. One current team per member keeps every record in one group.
function reportTeamTree(actorId:string,workspaceId?:string,teamId?:string){
  const workspace=workspaceId??sql`(SELECT ${privateWorkspaces.id} FROM ${privateWorkspaces} WHERE ${privateWorkspaces.ownerId}=${actorId})`;
  return sql`WITH RECURSIVE report_teams(workspace_id,id,root_id,root_name,path,in_branch) AS (
    SELECT workspace_id,id,id,name,name,${teamId?sql`id=${teamId}::uuid`:sql`false`} FROM ${workspaceTeams} WHERE workspace_id=${workspace} AND parent_id IS NULL
    UNION ALL
    SELECT child.workspace_id,child.id,parent.root_id,parent.root_name,parent.path || ' / ' || child.name,
      ${teamId?sql`parent.in_branch OR child.id=${teamId}::uuid`:sql`false`}
    FROM ${workspaceTeams} child JOIN report_teams parent ON child.workspace_id=parent.workspace_id AND child.parent_id=parent.id
  )`;
}

async function reportPopulation(db:PostgresJsDatabase,actorId:string,d:PortableReportDefinition,workspaceId?:string){
  const table=sources[d.kind];
  const byDealStage=d.kind==='deals'&&d.groupBy==='stage';
  const stageKey=sql`coalesce(${deals.pipelineId}::text||':'||${deals.stageId}::text,${deals.data}->>'stage')`;
  const companyGroup=d.kind==='deals'?relatedCompanyGroup(d.groupBy):undefined;
  // Keep each visible Deal once; an unavailable Company contributes no grouping value.
  const relatedJoin=companyGroup?sql`LEFT JOIN ${companies} ON ${and(eq(companies.workspaceId,deals.workspaceId),
    eq(companies.id,deals.companyId),activeCompany,sharedCoreRecordScope(db,actorId,workspaceId,companies))}`:sql``;
  const byResponse=d.groupBy==='firstResponseOutcome';
  const byChannel=d.groupBy==='firstResponseChannel';
  const responseAverage=d.metric==='average';
  const responseRate=d.metric==='rate';
  const responseJoin=responseRate||byResponse||byChannel||d.ticketResponse||d.firstResponseChannel||responseAverage?sql`LEFT JOIN ${responseReceipts} ON ${and(eq(responseReceipts.workspaceId,portableTickets.workspaceId),
    eq(responseReceipts.ticketId,portableTickets.id))}`:sql``;
  const responses=firstResponseConditions(sql`statement_timestamp()`);
  const responseOutcome=sql`CASE ${sql.join(firstResponseOutcomes.map(key=>
    sql`WHEN ${responses[key]} THEN ${key}::text`),sql` `)} END`;
  const byPerson=d.groupBy==='recordOwner'||d.groupBy==='assignee';
  const owner=sql`${table.data}->'recordOwner'`;
  const ownerId='assigneeId' in table?table.assigneeId:sql`CASE WHEN ${owner}->>'workspaceId'=${table.workspaceId}::text THEN nullif(${owner}->>'userId','') END`;
  const ownerLabel='assigneeLabel' in table?table.assigneeLabel:sql`${owner}->>'label'`;
  const byTeam=isTeamReportGroup(d.groupBy);
  const usesTeams=byTeam||!!d.teamId;
  const teamJoin=usesTeams?sql`LEFT JOIN ${workspaceViewers} assigned ON assigned.workspace_id=${table.workspaceId}
    AND assigned.viewer_id=${ownerId} AND assigned.role='editor'
    LEFT JOIN report_teams team ON team.workspace_id=assigned.workspace_id AND team.id=assigned.team_id`:sql``;
  const teamKey=d.groupBy==='topLevelTeam'?sql`team.root_id::text`:sql`team.id::text`;
  const teamName=d.groupBy==='topLevelTeam'?sql`team.root_name`:sql`team.path`;
  const dimension=byTeam?teamKey:byPerson?ownerId:byResponse?responseOutcome:byChannel?responseReceipts.channel:companyGroup?sql`nullif(${companies.data}->>${companyGroup.field},'')`:
    byDealStage?stageKey:d.groupBy?sql`nullif(${table.data}->>${d.groupBy},'')`:sql`null::text`;
  const label=byTeam?sql`coalesce(${teamName},'No assigned team')`:byPerson?sql`CASE WHEN ${ownerId} IS NULL THEN 'Unassigned' ELSE coalesce(nullif(${ownerLabel},''),'Assigned teammate') END`:byResponse?sql`CASE ${responseOutcome} ${sql.join(Object.entries(firstResponseOutcomeLabels)
    .map(([key,name])=>sql`WHEN ${key}::text THEN ${name}::text`),sql` `)} END`:byDealStage?sql`coalesce(${dealPipelineStages.name},${deals.data}->>'stage')`:dimension;
  const stagesJoin=byDealStage||d.dealOutcome?sql`LEFT JOIN ${dealPipelineStages} ON ${dealPipelineStages.workspaceId}=${deals.workspaceId}
    AND ${dealPipelineStages.pipelineId}=${deals.pipelineId} AND ${dealPipelineStages.id}=${deals.stageId}`:sql``;
  const measure=responseRate?sql`CASE WHEN ${responses.met} THEN 100 ELSE 0 END`:responseAverage?responseReceipts.workingMs:d.metric==='sum'
    ?sql`CASE WHEN jsonb_typeof(${deals.data}->'amount')='number' THEN (${deals.data}->>'amount')::numeric END`
    :sql`null::numeric`;
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
  const ownership=d.kind==='leads'?leadOwnership:d.kind==='tasks'?taskOwnership:d.kind==='tickets'?ticketOwnership:table;
  const visible=sharedCoreRecordScope(db,actorId,workspaceId,ownership);
  const scope=and(visible??recordWorkspaceScope(db,actorId,workspaceId),d.teamId?sql`team.in_branch`:undefined,custom,d.kind==='contacts'?activeContact:d.kind==='companies'?activeCompany:d.kind==='deals'?activeDeal:d.kind==='tasks'?activeTask:d.kind==='leads'?activeLead:activeTicket,
    d.firstResponseChannel?eq(responseReceipts.channel,d.firstResponseChannel):undefined,
    responseRate?or(responses.met,responses.late,responses.overdue):undefined,
    responseAverage?isNotNull(responseReceipts.respondedAt):undefined,condition,priority,ticketSource,ticketCategory,d.ticketResponse?responses[d.ticketResponse]:undefined,outcome,created,due,assignee,stage,d.dealPipelineId?dealPipelineScope(d.dealPipelineId):undefined);
  return sql`${usesTeams?reportTeamTree(actorId,workspaceId,d.teamId):sql``} SELECT ${table.id} AS id,coalesce(nullif(${table.data}->>'name',''),'Untitled') AS name,
    ${dimension} AS group_key,coalesce(${label},${byChannel?'No recorded first response':'No value'}::text) AS group_label,${measure} AS measure_value
    FROM ${table} INNER JOIN ${privateWorkspaces} ON ${privateWorkspaces.id}=${table.workspaceId}
    ${stagesJoin} ${relatedJoin} ${responseJoin} ${teamJoin} WHERE ${scope}`;
}

export async function evaluatePortableReport(db:PostgresJsDatabase,actorId:string,d:PortableReportDefinition,groupLimit=portableReportGroupLimit,
  workspaceId?:string):Promise<PortableReportResult>{
  const population=await reportPopulation(db,actorId,d,workspaceId);
  const aggregate=d.metric==='rate'?sql`round(avg(measure_value),2)`:d.metric==='average'?sql`round(avg(measure_value) / 60000,2)`:d.metric==='sum'?sql`sum(measure_value)`:sql`count(*)`;
  const sort=d.sort==='label'?sql``:d.sort==='value-asc'?sql`${aggregate} ASC NULLS LAST,`:sql`${aggregate} DESC NULLS LAST,`;
  // Keep names readable when different identities or team paths have the same display label.
  const name=sql`max(group_label)`;
  const groupLabel=isTeamReportGroup(d.groupBy)||d.groupBy==='recordOwner'||d.groupBy==='assignee'?sql`CASE WHEN group_key IS NOT NULL
    AND count(*) OVER (PARTITION BY GROUPING(group_key),${name})>1 THEN ${name} || ' · ' ||
      CASE WHEN count(*) OVER (PARTITION BY ${name},right(group_key,8))>1 THEN group_key ELSE right(group_key,8) END
    ELSE ${name} END`:name;
  // This query aggregates the full authorized population in Postgres. The
  // limit caps response groups only, with the grand total in the same snapshot.
  const [total,...groups]=await db.execute<{key:string|null;label:string;count:string;value:string|null}>(sql`
    WITH population AS (${population})
    SELECT group_key AS key,${groupLabel} AS label,count(*)::text AS count,${aggregate}::text AS value
    FROM population GROUP BY GROUPING SETS ((group_key),())
    HAVING GROUPING(group_key)=1 OR ${!!d.groupBy}
    ORDER BY GROUPING(group_key) DESC,${sort}lower(max(group_label)) COLLATE "C",max(group_label) COLLATE "C",group_key COLLATE "C"
    LIMIT ${groupLimit+2}
  `);
  return {total:total.value,count:total.count,rows:groups.slice(0,groupLimit),truncated:groups.length>groupLimit};
}

// Call inside the same transaction that authorizes the report or dashboard.
export async function readPortableReportRecords(db:PostgresJsDatabase,actor:RecordAccessActor,definition:PortableReportDefinition,
  {workspaceId,after,group}:{workspaceId?:string;after?:string;group?:string},includeBody:boolean){
  const population=await reportPopulation(db,actor.userId,definition,workspaceId);
  const filter=and(after?sql`id>${after}::uuid`:undefined,
    group===undefined?undefined:group===''?sql`group_key IS NULL`:sql`group_key=${group}`);
  const records=await db.execute<{id:string;name:string}>(sql`WITH population AS (${population})
    SELECT id,name FROM population ${filter?sql`WHERE ${filter}`:sql``} ORDER BY id LIMIT 26`);
  const page=records.slice(0,25);
  if(includeBody){
    await recordAccess(db,actor,definition.kind,'report',page.map(row=>row.id),workspaceId);
  }
  return {kind:definition.kind,records:page,next:records.length>page.length?page.at(-1)!.id:null};
}
