import {and,asc,eq,gt,isNotNull,isNull,ne,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {PortableArchivedRecord,PortableArchiveInput,PortableArchiveReceipt} from '../../lib/portable-contact-archive';
import {companyArchiveReceipts as receipts,companyEvents,companies} from './company-schema';
import {activeCompany} from './company-visibility';
import {lockRecordWorkspace} from './private-workspace-store';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {archiveAccessError,archivedByLabel,archiveWorkspaceScope} from './portable-archive-scope';
import {privateWorkspaces} from './workspace-schema';

type Db=PostgresJsDatabase;
const pageSize=25;
const at=(value:string|null)=>value===null?null:new Date(value).toISOString();

export async function readPortableCompanyArchive(db:Db,actorId:string,after?:string,shared?:SharedRecordWriteScope){
  const rows=await db.select({id:companies.id,name:sql<string>`${companies.data}->>'name'`,
    domain:sql<string>`coalesce(${companies.data}->>'domain','')`,revision:companies.revision,archivedAt:companies.archivedAt,
    archivedBy:archivedByLabel(companyEvents,companyEvents.companyId,companies.id,companies.workspaceId,companies.revision)})
    .from(companies).innerJoin(privateWorkspaces,eq(privateWorkspaces.id,companies.workspaceId))
    // A merged Company lives on in the one it was merged into, so it isn't listed.
    .where(and(archiveWorkspaceScope(db,actorId,shared),isNotNull(companies.archivedAt),isNull(companies.mergedIntoId),after?gt(companies.id,after):undefined))
    .orderBy(asc(companies.id)).limit(pageSize+1);
  const records:PortableArchivedRecord[]=rows.slice(0,pageSize).map(row=>({...row,archivedAt:at(row.archivedAt)!}));
  return {records,next:rows.length>pageSize?records.at(-1)!.id:null};
}

// Archive hides the Company and keeps every stored link. Contacts, Deals, Leads,
// Tickets and Tasks show no Company while it is archived and the same link again
// after restore, unless that record was relinked in the meantime.
export function changePortableCompanyArchive(db:Db,actorId:string,input:PortableArchiveInput,shared?:SharedRecordWriteScope):Promise<PortableArchiveReceipt>{
  return db.transaction(async tx=>{
    // Link writers take this lock before checking that a Company is active.
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,undefined,true);
    if(!workspaceId)throw shared?new ApiError(403,archiveAccessError):new ApiError(404,'Company not found in your workspace.');
    const {id,requestId,expectedRevision,action}=input;
    const [previous]=await tx.select().from(receipts).where(and(eq(receipts.workspaceId,workspaceId),eq(receipts.requestId,requestId)));
    if(previous){
      if(previous.companyId!==id||previous.action!==action||previous.revision!==expectedRevision+1){
        throw new ApiError(409,'That request ID was used for a different Company change.');
      }
      return {id,action,revision:previous.revision,archivedAt:at(previous.archivedAt)};
    }
    const scope=and(eq(companies.workspaceId,workspaceId),eq(companies.id,id));
    const [company]=await tx.select({archivedAt:companies.archivedAt,revision:companies.revision,data:companies.data,mergedIntoId:companies.mergedIntoId})
      .from(companies).where(scope).for('update');
    if(!company||company.mergedIntoId)throw new ApiError(404,'Company not found in your workspace.');
    if(company.revision!==expectedRevision||Boolean(company.archivedAt)!==(action==='restore')){
      throw new ApiError(409,'This Company changed. Refresh before trying again.');
    }
    const domain=company.data.domain?.trim().toLowerCase();
    if(action==='restore'&&domain){
      // Import and paired-import matching use the domain as the Company key.
      const [duplicate]=await tx.select({id:companies.id}).from(companies)
        .where(and(eq(companies.workspaceId,workspaceId),ne(companies.id,id),activeCompany,
          sql`lower(${companies.data}->>'domain')=${domain}`)).limit(1);
      if(duplicate)throw new ApiError(409,'An active Company already has this domain.');
    }
    const now=new Date().toISOString(),archivedAt=action==='archive'?now:null,revision=expectedRevision+1;
    await tx.update(companies).set({archivedAt,revision,updatedAt:now}).where(scope);
    // Keep each record revision addressable by history readers.
    await tx.insert(companyEvents).values({workspaceId,companyId:id,revision,actorId,
      previous:company.data,data:company.data,occurredAt:now});
    await tx.insert(receipts).values({workspaceId,requestId,companyId:id,action,revision,archivedAt});
    return {id,action,revision,archivedAt};
  });
}
