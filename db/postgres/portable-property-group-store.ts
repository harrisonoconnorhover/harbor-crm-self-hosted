import {hiddenStandardFields} from './standard-property-access';
import {and,eq,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {portablePropertyGroupFields,type PortableCustomPropertyKind,type PortablePropertyGroupWrite} from '../../lib/portable-custom-properties';
import {changePropertyOrganization,normalizePropertyOrganization,type PropertyGroupState,type PropertyOrganization} from '../../lib/property-groups';
import {portableCustomProperties as properties,portablePropertyOrganizations as organizations} from './custom-property-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {recordCatalogScope} from './workspace-viewer-store';
import {privateWorkspaces} from './workspace-schema';

const empty:PropertyOrganization={groups:[],assignments:{}};
const columns={revision:organizations.revision,config:organizations.config};
const state=(kind:PortableCustomPropertyKind,row?:{revision:number;config:PropertyOrganization}):PropertyGroupState=>
  ({kind,revision:row?.revision??0,...(row?.config??empty)});

export async function readPortablePropertyGroups(db:PostgresJsDatabase,actorId:string,kind:PortableCustomPropertyKind,workspaceId?:string){
  const config=workspaceId?sql<PropertyOrganization>`jsonb_set(${organizations.config},'{assignments}',
    coalesce(${organizations.config}->'assignments','{}'::jsonb) - ARRAY(${hiddenStandardFields(workspaceId,kind,actorId)}))`:organizations.config;
  const [row]=await db.select({revision:organizations.revision,config}).from(organizations)
    .innerJoin(privateWorkspaces,eq(organizations.workspaceId,privateWorkspaces.id))
    .where(and(recordCatalogScope(db,actorId,workspaceId),eq(organizations.kind,kind)));
  return state(kind,row);
}

export function writePortablePropertyGroups(db:PostgresJsDatabase,ownerId:string,{kind,revision,change}:PortablePropertyGroupWrite){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,ownerId,change.action==='create',undefined,undefined,true);
    if(!workspaceId)throw new ApiError(404,'Property groups are unavailable.');
    const scope=and(eq(organizations.workspaceId,workspaceId),eq(organizations.kind,kind));
    const [row]=await tx.select(columns).from(organizations).where(scope);
    const current=state(kind,row);
    const fields=portablePropertyGroupFields(kind,await tx.select({
      id:properties.id,label:properties.label,type:properties.type,options:properties.options,
    }).from(properties).where(and(eq(properties.workspaceId,workspaceId),eq(properties.kind,kind))));
    const before=normalizePropertyOrganization(kind,fields,current);
    let config:PropertyOrganization;
    try{config=changePropertyOrganization({...current,...before},fields,change);}
    catch(error){throw new ApiError(400,error instanceof Error?error.message:'Choose available properties and a group.');}
    if(JSON.stringify(before)===JSON.stringify(config))return {...current,...before};
    if(current.revision!==revision)throw new ApiError(409,'Property groups changed in another session. Reload groups before trying again.');
    const next={config,revision:revision+1};
    if(row)await tx.update(organizations).set(next).where(scope);
    else await tx.insert(organizations).values({workspaceId,kind,...next});
    return state(kind,next);
  });
}
