import {and,eq,inArray} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {CRMRecord} from '../../lib/crm';
import {compareDuplicateCursor,duplicateEvidence,duplicateKey,findDuplicates,pairCursor,type DuplicatePair} from '../../lib/duplicates';
import type {PortableDuplicateAction,PortableDuplicatePage,PortableDuplicateQuery,PortableDuplicateRecord} from '../../lib/portable-duplicates';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {companies} from './company-schema';
import {activeCompany} from './company-visibility';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {portableDuplicateDismissals as dismissals} from './portable-duplicate-schema';
import {lockRecordWorkspace} from './private-workspace-store';

type Db=PostgresJsDatabase;
const pageSize=50,suggestionLimit=10_000;

// Native duplicate rules read CRMRecord-shaped rows; portable rows supply the fields they use.
async function scanRows(db:Pick<Db,'select'>,workspaceId:string){
  const companyRows=await db.select({id:companies.id,revision:companies.revision,data:companies.data}).from(companies)
    .where(and(eq(companies.workspaceId,workspaceId),activeCompany));
  const contactRows=await db.select({id:contacts.id,revision:contacts.revision,data:contacts.data,companyId:contacts.primaryCompanyId}).from(contacts)
    .where(and(eq(contacts.workspaceId,workspaceId),activeContact));
  const revisions=new Map<string,number>();
  const rows=[
    ...companyRows.map(row=>{revisions.set(row.id,row.revision);return {id:row.id,kind:'companies',data:{name:row.data.name,domain:row.data.domain,city:row.data.city}};}),
    ...contactRows.map(row=>{revisions.set(row.id,row.revision);return {id:row.id,kind:'contacts',
      data:{name:row.data.name,email:row.data.email,phone:row.data.phone,companyId:row.companyId??undefined}};}),
  ] as unknown as CRMRecord[];
  return {rows,revisions};
}

function present(record:CRMRecord,revisions:Map<string,number>,byId:Map<string,CRMRecord>):PortableDuplicateRecord{
  const data=record.data as {name?:string;email?:string;phone?:string;domain?:string;city?:string;companyId?:string};
  const company=data.companyId?byId.get(data.companyId)?.data.name:undefined;
  return {id:record.id,revision:revisions.get(record.id)!,name:data.name??'',
    ...Object.fromEntries(Object.entries({email:data.email,phone:data.phone,domain:data.domain,city:data.city,company}).filter(([,value])=>value))};
}

export async function readPortableDuplicates(db:Db,workspaceId:string,query:PortableDuplicateQuery):Promise<PortableDuplicatePage>{
  const [{rows,revisions},dismissed]=await Promise.all([scanRows(db,workspaceId),
    db.select().from(dismissals).where(and(eq(dismissals.workspaceId,workspaceId),eq(dismissals.kind,query.kind)))]);
  const byId=new Map(rows.map(row=>[row.id,row]));
  const search=query.query.trim().toLowerCase();
  const matches=(pair:DuplicatePair)=>(!search||[pair.left,pair.right].some(record=>[record.data.name,record.data.email,record.data.domain]
    .some(value=>value?.toLowerCase().includes(search))))&&(query.strength!=='strong'||pair.score>=90)&&(query.strength!=='possible'||pair.score<90);
  let pairs:DuplicatePair[],limited=false;
  if(query.status==='dismissed'){
    // Dismissals for merged or archived records drop out with them.
    pairs=dismissed.flatMap(row=>{
      const left=byId.get(row.recordA),right=byId.get(row.recordB);
      if(!left||!right)return [];
      const evidence=duplicateEvidence(left,right,byId);
      return [{...(evidence??{left,right,score:0,reasons:['No longer suggested by current matching rules']}),dismissedAt:new Date(row.createdAt).toISOString()}];
    }).filter(matches).sort((a,b)=>compareDuplicateCursor(pairCursor(a),pairCursor(b)));
  }else{
    const scan=findDuplicates(rows,query.kind,suggestionLimit,{excluded:new Set(dismissed.map(row=>duplicateKey(row.recordA,row.recordB))),
      query:query.query,strength:query.strength});
    pairs=scan.pairs;limited=scan.limited;
  }
  const remaining=query.cursor?pairs.filter(pair=>compareDuplicateCursor(pairCursor(pair),query.cursor!)>0):pairs;
  const page=remaining.slice(0,pageSize);
  return {
    pairs:page.map(pair=>({left:present(pair.left,revisions,byId),right:present(pair.right,revisions,byId),score:pair.score,reasons:pair.reasons,
      ...(pair.dismissedAt?{dismissedAt:pair.dismissedAt}:{})})),
    nextCursor:remaining.length>pageSize?JSON.stringify(pairCursor(page.at(-1)!)):null,total:pairs.length,limited,
    recordsChecked:rows.filter(row=>row.kind===query.kind).length,
  };
}

export function changePortableDuplicateDismissal(db:Db,actorId:string,input:PortableDuplicateAction,shared?:SharedRecordWriteScope){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared);
    if(!workspaceId)throw shared?new ApiError(403,'Editor access to this workspace is required.'):new ApiError(404,'One of these records is no longer available.');
    const [recordA,recordB]=[input.recordA,input.recordB].sort() as [string,string];
    const table=input.kind==='contacts'?contacts:companies,active=input.kind==='contacts'?activeContact:activeCompany;
    const found=await tx.select({id:table.id}).from(table).where(and(eq(table.workspaceId,workspaceId),active,inArray(table.id,[recordA,recordB])));
    if(found.length!==2)throw new ApiError(404,'One of these records is no longer available.');
    const pair=and(eq(dismissals.workspaceId,workspaceId),eq(dismissals.recordA,recordA),eq(dismissals.recordB,recordB));
    if(input.action==='restore')await tx.delete(dismissals).where(pair);
    else await tx.insert(dismissals).values({workspaceId,kind:input.kind,recordA,recordB,actorId,createdAt:new Date().toISOString()})
      .onConflictDoNothing();
    return {ok:true as const};
  });
}
