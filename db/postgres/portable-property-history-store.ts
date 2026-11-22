import {hiddenStandardFields} from './standard-property-access';
import {isRestrictableStandardField} from '../../lib/portable-standard-property-access';
import {propertyVisibleTo} from './record-property-access';
import {sharedCoreRecordScope} from './record-ownership-scope';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {activeDeal} from './deal-visibility';
import {and,desc,eq,lt,sql,type SQLWrapper} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portableCustomHistoryId,portableHistoryFields,type PortableRecordHistoryPage,type PortablePropertyChange,type PortablePropertyHistoryQuery} from '../../lib/portable-property-history';
import {companies,companyEvents} from './company-schema';
import {contacts,contactEvents} from './contact-schema';
import {deals,dealEvents} from './deal-schema';
import {loginIdentities} from './identity-schema';
import {portableCustomProperties} from './custom-property-schema';
import {privateWorkspaces} from './workspace-schema';
import {recordWorkspaceScope} from './workspace-viewer-store';

const recordTables={contacts,companies,deals};
const tables={contacts:contactEvents,companies:companyEvents,deals:dealEvents};
const recordIds={contacts:contactEvents.contactId,companies:companyEvents.companyId,deals:dealEvents.dealId};
const pageSize=25;
function historyActor(kind:PortablePropertyHistoryQuery['kind']){
  const person=sql<string|null>`coalesce(nullif(trim(${loginIdentities.fullName}),''),${loginIdentities.email})`;
  return kind==='contacts'?sql<string|null>`CASE WHEN ${contactEvents.intakeFormId} IS NOT NULL AND ${contactEvents.previous} IS NOT NULL
    THEN 'Website form routing'
    ELSE ${person} END`:person;
}

export function readPortablePropertyHistory(db:PostgresJsDatabase,actorId:string,query:PortablePropertyHistoryQuery){
  return db.transaction(async tx=>{
    const {kind,history:id,field,before,workspaceId}=query;
    const records=recordTables[kind];
    const [record]=await tx.select({workspaceId:records.workspaceId}).from(records)
      .innerJoin(privateWorkspaces,eq(records.workspaceId,privateWorkspaces.id))
      .where(and(sharedCoreRecordScope(tx,actorId,workspaceId,records)??recordWorkspaceScope(tx,actorId,workspaceId),eq(records.id,id),kind==='contacts'?activeContact:kind==='companies'?activeCompany:kind==='deals'?activeDeal:undefined)).limit(1);
    if(!record)return null;
    if(!field)return readAllChanges(tx,actorId,record.workspaceId,query);
    const customId=portableCustomHistoryId(field);
    if(workspaceId&&isRestrictableStandardField(kind,field)){
      const [hidden]=await tx.execute(sql`SELECT 1 WHERE ${field} IN (${hiddenStandardFields(record.workspaceId,kind,actorId)})`);
      if(hidden)return null;
    }
    let definitionId:string|undefined;
    if(customId){
      const property=portableCustomProperties;
      const [definition]=await tx.select({id:property.id}).from(property)
        .where(and(eq(property.workspaceId,record.workspaceId),eq(property.kind,kind),eq(property.id,customId),workspaceId?propertyVisibleTo(actorId):undefined)).limit(1);
      if(!definition)return null;
      definitionId=definition.id;
    }
    const event=tables[kind],recordId=recordIds[kind];
    const property=(column:SQLWrapper)=>{
      if(field==='owner')return sql<PortablePropertyChange['value']>`${column} -> 'recordOwner' ->> 'label'`;
      if(definitionId)return sql<PortablePropertyChange['value']>`nullif(nullif(${column} -> 'custom' -> ${definitionId}::text,'""'::jsonb),'null'::jsonb)`;
      return sql<PortablePropertyChange['value']>`nullif(${column} -> ${field}::text,'""'::jsonb)`;
    };
    const previous=property(event.previous),value=property(event.data);
    const changed=field==='owner'?sql`(${event.previous} -> 'recordOwner') is distinct from (${event.data} -> 'recordOwner')`:
      sql`${previous} is distinct from ${value}`;
    const rows=await tx.select({revision:event.revision,
      occurredAt:event.occurredAt,actorName:historyActor(kind),previous,value})
      .from(event).leftJoin(loginIdentities,eq(event.actorId,loginIdentities.id))
      .where(and(eq(event.workspaceId,record.workspaceId),eq(recordId,id),
        before===undefined?undefined:lt(event.revision,before),changed))
      .orderBy(desc(event.revision)).limit(pageSize+1);
    const items=rows.slice(0,pageSize).map(row=>({...row,occurredAt:new Date(row.occurredAt).toISOString()}));
    return {items,next:rows.length>pageSize?items.at(-1)!.revision:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

// The property catalog is filtered before projecting values or matching search text.
// Expand only keys present in the two snapshots, then discard unchanged values.
async function readAllChanges(db:PostgresJsDatabase,actorId:string,recordWorkspaceId:string,query:PortablePropertyHistoryQuery):Promise<PortableRecordHistoryPage>{
  const {kind,history:id,before,afterField,search,workspaceId}=query;
  const event=tables[kind],recordId=recordIds[kind],property=portableCustomProperties;
  const core=JSON.stringify(Object.fromEntries(portableHistoryFields(kind)));
  const snapshotValue=(column:SQLWrapper)=>sql`CASE
    WHEN fields.key='owner' THEN ${column}->'recordOwner'
    WHEN left(fields.key,7)='custom:' THEN ${column}->'custom'->substr(fields.key,8)
    ELSE ${column}->fields.key END`;
  const normalized=(column:SQLWrapper)=>sql`nullif(nullif(${snapshotValue(column)},'""'::jsonb),'null'::jsonb)`;
  type Row=PortableRecordHistoryPage['items'][number];
  const rows=await db.execute<Row>(sql`
    WITH fields(key,label) AS (
      SELECT key,value FROM jsonb_each_text(${core}::jsonb)
      ${workspaceId?sql`WHERE key NOT IN (${hiddenStandardFields(recordWorkspaceId,kind,actorId)})`:sql``}
      UNION ALL
      SELECT 'custom:' || ${property.id}::text,${property.label} FROM ${property}
      WHERE ${property.workspaceId}=${recordWorkspaceId} AND ${property.kind}=${kind}
        ${workspaceId?sql`AND ${propertyVisibleTo(actorId)}`:sql``}
    ), changes AS (
      SELECT ${event.revision} AS revision,${event.occurredAt} AS "occurredAt",${historyActor(kind)} AS "actorName",
        fields.key AS field,fields.label,
        CASE WHEN fields.key='owner' THEN diff.old->'label' ELSE diff.old END AS previous,
        CASE WHEN fields.key='owner' THEN diff.new->'label' ELSE diff.new END AS value
      FROM ${event}
      LEFT JOIN ${loginIdentities} ON ${event.actorId}=${loginIdentities.id}
      CROSS JOIN LATERAL (
        SELECT CASE WHEN key='recordOwner' THEN 'owner' ELSE key END AS key
        FROM jsonb_object_keys(coalesce(${event.previous},'{}') || ${event.data}) AS key
        WHERE key NOT IN ('owner','custom')
        UNION ALL
        SELECT 'custom:' || key FROM jsonb_object_keys(coalesce(${event.previous}->'custom','{}') || coalesce(${event.data}->'custom','{}')) AS key
      ) candidates JOIN fields ON fields.key=candidates.key
      CROSS JOIN LATERAL (SELECT ${normalized(event.previous)} AS old,${normalized(event.data)} AS new) diff
      WHERE ${event.workspaceId}=${recordWorkspaceId} AND ${recordId}=${id} AND diff.old IS DISTINCT FROM diff.new
        ${before===undefined?sql``:sql`AND (${event.revision}<${before} OR (${event.revision}=${before} AND fields.key COLLATE "C">${afterField}))`}
    )
    SELECT * FROM changes
    ${search?sql`WHERE strpos(lower(concat_ws(' ',label,previous #>> '{}',value #>> '{}',"actorName")),lower(${search}))>0`:sql``}
    ORDER BY revision DESC,field COLLATE "C" LIMIT ${pageSize+1}
  `);
  const items=rows.slice(0,pageSize).map(row=>({...row,occurredAt:new Date(row.occurredAt).toISOString()}));
  const last=items.at(-1);
  return {items,next:rows.length>pageSize&&last?{revision:last.revision,field:last.field}:null};
}
