import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {activeDeal} from './deal-visibility';
import {and,desc,eq,lt,sql,type SQLWrapper} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portableCustomHistoryId,type PortablePropertyChange,type PortablePropertyHistoryQuery} from '../../lib/portable-property-history';
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

export function readPortablePropertyHistory(db:PostgresJsDatabase,actorId:string,query:PortablePropertyHistoryQuery){
  return db.transaction(async tx=>{
    const {kind,history:id,field,before,workspaceId}=query;
    const records=recordTables[kind];
    const [record]=await tx.select({workspaceId:records.workspaceId}).from(records)
      .innerJoin(privateWorkspaces,eq(records.workspaceId,privateWorkspaces.id))
      .where(and(recordWorkspaceScope(tx,actorId,workspaceId),eq(records.id,id),kind==='contacts'?activeContact:kind==='companies'?activeCompany:kind==='deals'?activeDeal:undefined)).limit(1);
    if(!record)return null;
    const customId=portableCustomHistoryId(field);
    let definitionId:string|undefined;
    if(customId){
      const property=portableCustomProperties;
      const [definition]=await tx.select({id:property.id}).from(property)
        .where(and(eq(property.workspaceId,record.workspaceId),eq(property.kind,kind),eq(property.id,customId))).limit(1);
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
      occurredAt:event.occurredAt,actorName:loginIdentities.fullName,previous,value})
      .from(event).leftJoin(loginIdentities,eq(event.actorId,loginIdentities.id))
      .where(and(eq(event.workspaceId,record.workspaceId),eq(recordId,id),
        before===undefined?undefined:lt(event.revision,before),changed))
      .orderBy(desc(event.revision)).limit(pageSize+1);
    const items=rows.slice(0,pageSize).map(row=>({...row,occurredAt:new Date(row.occurredAt).toISOString()}));
    return {items,next:rows.length>pageSize?items.at(-1)!.revision:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
