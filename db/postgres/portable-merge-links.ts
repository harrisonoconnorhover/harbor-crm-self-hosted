import {and,eq,or} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {PortableMergeKind} from '../../lib/portable-record-merge';
import type {PortableRecordKind} from '../../lib/portable-records';
import {portableAssociations as links} from './portable-association-schema';

type Tx=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type Endpoint={kind:PortableRecordKind;id:string};
const key=(endpoint:Endpoint)=>endpoint.kind+'/'+endpoint.id;

export const mergeEndpointOf=(kind:PortableMergeKind,id:string)=>
  or(and(eq(links.firstKind,kind),eq(links.firstId,id)),and(eq(links.secondKind,kind),eq(links.secondId,id)));

function pairScope(workspaceId:string,a:Endpoint,b:Endpoint){
  const [first,second]=key(a)<key(b)?[a,b]:[b,a];
  return {first,second,scope:and(eq(links.workspaceId,workspaceId),eq(links.firstKind,first.kind),eq(links.firstId,first.id),
    eq(links.secondKind,second.kind),eq(links.secondId,second.id))};
}

// Add labels to the link between two records, creating it when missing.
export async function mergeLinkLabels(tx:Tx,workspaceId:string,a:Endpoint,b:Endpoint,add:string[]){
  const {first,second,scope}=pairScope(workspaceId,a,b);
  const [existing]=await tx.select({labels:links.labels}).from(links).where(scope).for('update');
  const labels=[...new Set([...(existing?.labels??[]),...add])].sort();
  if(labels.length>5)throw new ApiError(409,'A shared association would have more than five labels. Remove some labels before merging.');
  if(existing)await tx.update(links).set({labels}).where(scope);
  else await tx.insert(links).values({workspaceId,id:crypto.randomUUID(),firstKind:first.kind,firstId:first.id,secondKind:second.kind,secondId:second.id,labels});
}

// Each secondary association moves to the primary. A partner already linked to
// both combines its labels; the link between the two merged records goes away.
export async function moveMergedAssociations(tx:Tx,workspaceId:string,kind:PortableMergeKind,primaryId:string,secondaryId:string){
  const rows=await tx.select().from(links).where(and(eq(links.workspaceId,workspaceId),mergeEndpointOf(kind,secondaryId))).for('update');
  const primary={kind,id:primaryId};
  for(const row of rows){
    const partner=row.firstKind===kind&&row.firstId===secondaryId?{kind:row.secondKind,id:row.secondId}:{kind:row.firstKind,id:row.firstId};
    await tx.delete(links).where(and(eq(links.workspaceId,workspaceId),eq(links.id,row.id)));
    if(key(partner)!==key(primary))await mergeLinkLabels(tx,workspaceId,primary,partner,row.labels);
  }
  return rows.length;
}
