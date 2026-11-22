import {sharedToolAllowed} from './shared-tool-permission';
import {and,count,eq,inArray,or,sql,type SQL} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {CRMRecord} from '../../lib/crm';
import {compareDuplicateCursor,duplicateEvidence,duplicateKey,findDuplicates,pairCursor,type DuplicateCursor,type DuplicatePair} from '../../lib/duplicates';
import type {PortableDuplicateAction,PortableDuplicatePage,PortableDuplicatePair,PortableDuplicateQuery,PortableDuplicateRecord} from '../../lib/portable-duplicates';
import type {SharedRecordWriteScope} from '../../lib/portable-workspace-access';
import {companies} from './company-schema';
import {activeCompany} from './company-visibility';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {portableDuplicateDismissals as dismissals} from './portable-duplicate-schema';
import {recordSearchCandidate} from './search-index';
import {eligibleDuplicateRows,suggestedCandidateIds} from './duplicate-candidates';
import {ownedRecordScope} from './record-ownership-scope';
import {lockRecordWorkspace} from './private-workspace-store';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
const pageSize=50,suggestionLimit=10_000;

// Native duplicate rules read CRMRecord-shaped rows; portable rows supply the fields they use.
async function scanRows(db:Db,workspaceId:string,kind:PortableDuplicateQuery['kind'],scopedEditor:string|undefined,ids:string[]|SQL){
  const table=kind==='contacts'?contacts:companies;
  const eligible=and(eligibleDuplicateRows(db,workspaceId,kind,scopedEditor),inArray(table.id,ids));
  const revisions=new Map<string,number>(),companyLookup=new Map<string,CRMRecord>();
  const rows:CRMRecord[]=[];
  if(kind==='companies'){
    const candidates=await db.select({id:companies.id,revision:companies.revision,name:sql<string>`${companies.data}->>'name'`,
      domain:sql<string>`${companies.data}->>'domain'`,city:sql<string>`${companies.data}->>'city'`}).from(companies)
      .where(eligible);
    for(const {id,revision,...data} of candidates){
      rows.push({id,kind,data} as CRMRecord);
      revisions.set(id,revision);
    }
  }else{
    const candidates=await db.select({id:contacts.id,revision:contacts.revision,name:sql<string>`${contacts.data}->>'name'`,
      email:sql<string>`${contacts.data}->>'email'`,phone:sql<string>`${contacts.data}->>'phone'`,
      companyId:companies.id,companyName:sql<string|null>`${companies.data}->>'name'`}).from(contacts)
      .leftJoin(companies,and(eq(contacts.workspaceId,companies.workspaceId),eq(contacts.primaryCompanyId,companies.id),activeCompany,
        scopedEditor?ownedRecordScope(db,scopedEditor,workspaceId,companies):undefined))
      .where(eligible);
    for(const {id,revision,companyId,companyName,...data} of candidates){
      rows.push({id,kind,data:{...data,companyId:companyId??undefined}} as CRMRecord);
      revisions.set(id,revision);
      if(companyId&&companyName)companyLookup.set(companyId,{id:companyId,kind:'companies',data:{name:companyName}} as CRMRecord);
    }
  }
  return {rows,revisions,companyLookup};
}

function present(record:CRMRecord,revisions:Map<string,number>,companyLookup:Map<string,CRMRecord>):PortableDuplicateRecord{
  const {email,phone,domain,city,companyId}=record.data;
  const company=companyId?companyLookup.get(companyId)?.data.name:undefined;
  return {id:record.id,revision:revisions.get(record.id)!,name:record.data.name??'',
    ...Object.fromEntries(Object.entries({email,phone,domain,city}).filter(([,value])=>value)),
    ...(company?{company,companyId}:{})};
}

function presentPair(pair:DuplicatePair,revisions:Map<string,number>,companiesById:Map<string,CRMRecord>):PortableDuplicatePair{
  return {left:present(pair.left,revisions,companiesById),right:present(pair.right,revisions,companiesById),
    score:pair.score,reasons:pair.reasons,...(pair.dismissedAt?{dismissedAt:pair.dismissedAt}:{})};
}

async function readDismissedPairs(db:Tx,workspaceId:string,query:PortableDuplicateQuery,scopedEditor?:string):Promise<PortableDuplicatePage>{
  const table=query.kind==='contacts'?contacts:companies;
  const [active]=await db.select({n:count()}).from(table).where(eligibleDuplicateRows(db,workspaceId,query.kind,scopedEditor));
  const search=query.query.trim().toLowerCase();
  // Use the existing scalar-value index to narrow the candidates, then match only
  // the two displayed search fields. Either record may match a saved decision.
  const identity=query.kind==='contacts'?sql`${table.data}->>'email'`:sql`${table.data}->>'domain'`;
  const fields=[sql`${table.data}->>'name'`,identity];
  const matches=db.$with('matching_duplicate_records').as(db.select({id:table.id}).from(table).where(and(
    eligibleDuplicateRows(db,workspaceId,query.kind,scopedEditor),recordSearchCandidate(table.data,search),
    or(...fields.map(field=>sql`strpos(lower((${field}) COLLATE pg_catalog.pg_unicode_fast) COLLATE "C",${search})>0`)),
  )));
  const matchingIds=db.select({id:matches.id}).from(matches);
  const matchEither=search?or(inArray(dismissals.recordA,matchingIds),inArray(dismissals.recordB,matchingIds)):undefined;
  // Both sides must be editable. Apply this before the cursor starts sending decisions for scoring.
  const editable=db.$with('editable_duplicate_records').as(db.select({id:table.id}).from(table)
    .where(eligibleDuplicateRows(db,workspaceId,query.kind,scopedEditor)));
  const editableIds=db.select({id:editable.id}).from(editable);
  const allowed=scopedEditor?and(inArray(dismissals.recordA,editableIds),inArray(dismissals.recordB,editableIds)):undefined;
  const decisionsQuery=db.with(...(search?[matches]:[]),...(scopedEditor?[editable]:[]));
  const best:{cursor:DuplicateCursor;pair:PortableDuplicatePair}[]=[];
  let total=0;
  // Run the search once even when a common term matches thousands of decisions.
  // The cursor belongs to this request's transaction and fetches a bounded batch for scoring.
  const selected=decisionsQuery.select({a:sql`${dismissals.recordA}`.as('a'),b:sql`${dismissals.recordB}`.as('b'),
    at:sql`${dismissals.createdAt}`.as('at')}).from(dismissals)
    .where(and(eq(dismissals.workspaceId,workspaceId),eq(dismissals.kind,query.kind),allowed,matchEither));
  await db.execute(sql`DECLARE duplicate_review_pairs NO SCROLL CURSOR FOR ${selected.getSQL()}`);
  for(;;){
    const decisions=await db.execute<{a:string;b:string;at:string}>(sql`FETCH FORWARD 256 FROM duplicate_review_pairs`);
    if(!decisions.length)break;
    const ids=[...new Set(decisions.flatMap(d=>[d.a,d.b]))];
    const {rows,revisions,companyLookup}=await scanRows(db,workspaceId,query.kind,scopedEditor,ids);
    const byId=new Map(rows.map(row=>[row.id,row]));
    for(const decision of decisions){
      const left=byId.get(decision.a),right=byId.get(decision.b);
      if(!left||!right)continue;
      const pair=duplicateEvidence(left,right,companyLookup)??{left,right,score:0,reasons:['No longer suggested by current matching rules']};
      if((query.strength==='strong'&&pair.score<90)||(query.strength==='possible'&&pair.score>=90))continue;
      total++;
      const cursor=pairCursor(pair);
      if(query.cursor&&compareDuplicateCursor(cursor,query.cursor)<=0)continue;
      best.push({cursor,pair:presentPair({...pair,dismissedAt:new Date(decision.at).toISOString()},revisions,companyLookup)});
    }
    best.sort((a,b)=>compareDuplicateCursor(a.cursor,b.cursor));
    if(best.length>pageSize+1)best.length=pageSize+1;
  }
  await db.execute(sql`CLOSE duplicate_review_pairs`);
  return {pairs:best.slice(0,pageSize).map(row=>row.pair),total,limited:false,recordsChecked:active.n,
    nextCursor:best.length>pageSize?JSON.stringify(best[pageSize-1].cursor):null};
}

export async function readPortableDuplicates(db:Tx,workspaceId:string,query:PortableDuplicateQuery,scopedEditor?:string):Promise<PortableDuplicatePage>{
  if(query.status==='dismissed')return readDismissedPairs(db,workspaceId,query,scopedEditor);
  const table=query.kind==='contacts'?contacts:companies;
  const candidates=await suggestedCandidateIds(db,workspaceId,query.kind,scopedEditor,query.query);
  const [{rows,revisions,companyLookup},[active]]=await Promise.all([scanRows(db,workspaceId,query.kind,scopedEditor,candidates),
    db.select({n:count()}).from(table).where(eligibleDuplicateRows(db,workspaceId,query.kind,scopedEditor))]);
  // Only dismissals between two scoring candidates can suppress a suggestion. Bind the
  // candidate IDs as one parameter, even when a large group shares a name or domain.
  const candidateIds=db.$with('scoring_ids').as(db.select({id:sql<string>`value::uuid`.as('id')})
    .from(sql`jsonb_array_elements_text(${JSON.stringify([...revisions.keys()])}::jsonb)`));
  const scoringIds=db.select({id:candidateIds.id}).from(candidateIds);
  const dismissed=rows.length<2?[]:await db.with(candidateIds).select({a:dismissals.recordA,b:dismissals.recordB}).from(dismissals)
    .where(and(eq(dismissals.workspaceId,workspaceId),eq(dismissals.kind,query.kind),
      inArray(dismissals.recordA,scoringIds),inArray(dismissals.recordB,scoringIds)));
  const {pairs,limited}=findDuplicates([...rows,...companyLookup.values()],query.kind,suggestionLimit,{
    excluded:new Set(dismissed.map(row=>duplicateKey(row.a,row.b))),query:query.query,strength:query.strength});
  const remaining=query.cursor?pairs.filter(pair=>compareDuplicateCursor(pairCursor(pair),query.cursor!)>0):pairs;
  const page=remaining.slice(0,pageSize);
  return {
    pairs:page.map(pair=>presentPair(pair,revisions,companyLookup)),
    nextCursor:remaining.length>pageSize?JSON.stringify(pairCursor(page.at(-1)!)):null,total:pairs.length,limited,
    recordsChecked:active.n,
  };
}

export function changePortableDuplicateDismissal(db:Db,actorId:string,input:PortableDuplicateAction,shared?:SharedRecordWriteScope){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,shared,undefined,!!shared,true);
    if(!workspaceId||!await sharedToolAllowed(tx,actorId,shared?.workspaceId,'duplicates','edit'))throw shared?new ApiError(403,'Editor access to this workspace is required.'):new ApiError(404,'One of these records is no longer available.');
    const [recordA,recordB]=[input.recordA,input.recordB].sort() as [string,string];
    const table=input.kind==='contacts'?contacts:companies,active=input.kind==='contacts'?activeContact:activeCompany;
    const found=await tx.select({id:table.id}).from(table).where(and(eq(table.workspaceId,workspaceId),active,inArray(table.id,[recordA,recordB]),
      shared?ownedRecordScope(tx,actorId,workspaceId,table,'edit',undefined,shared.grantId):undefined)).orderBy(table.id).for('share');
    if(found.length!==2)throw new ApiError(404,'One of these records is no longer available.');
    const pair=and(eq(dismissals.workspaceId,workspaceId),eq(dismissals.kind,input.kind),eq(dismissals.recordA,recordA),eq(dismissals.recordB,recordB));
    if(input.action==='restore')await tx.delete(dismissals).where(pair);
    else await tx.insert(dismissals).values({workspaceId,kind:input.kind,recordA,recordB,actorId,createdAt:new Date().toISOString()})
      .onConflictDoNothing();
    return {ok:true as const};
  });
}
