import {createHash} from 'node:crypto';
import {and,eq,ne,sql,type SQL} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {suppressedAddress} from '../../lib/email/suppression';
import {salesforceAudienceSourceFromEnv} from '../../lib/marketing-salesforce';
import {marketingAudienceFilter,type MarketingAudienceFilter,type MarketingAudienceStatus,type SalesforceAudiencePage,
  type SalesforceAudienceSource} from '../../lib/marketing-audience';
import {emailSuppressions} from './email-suppression-schema';
import {marketingAudienceAccounts as accounts,marketingAudienceContacts as contacts,marketingAudienceRelated as related,
  marketingAudienceSync as sync} from './marketing-audience-schema';

type Db=PostgresJsDatabase;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
const pageSize=25;
const fresh=sql`s.started_at > statement_timestamp() - interval '24 hours'`;

export async function marketingAudienceStatus(db:Db,workspaceId:string):Promise<MarketingAudienceStatus>{
  const [row]=await db.select({
    state:sql<MarketingAudienceStatus['state']>`CASE WHEN ${sync.state}='ready'
      AND ${sync.startedAt} <= statement_timestamp() - interval '24 hours' THEN 'stale' ELSE ${sync.state} END`,
    generation:sync.generation,startedAt:sync.startedAt,
    completedAt:sql<string|null>`to_char(${sync.completedAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    contacts:sync.contactCount,accounts:sync.accountCount,
    related:sync.relatedCount,mapping:sync.mapping,
  }).from(sync).where(eq(sync.workspaceId,workspaceId));
  return row??{state:'missing',generation:null,startedAt:null,completedAt:null,contacts:0,accounts:0,related:0,mapping:null};
}

// Select only normalized addresses. The address-level opt-out test deliberately precedes any
// audience criteria: an unsubscribed duplicate on another account vetoes the complete address.
export function eligibleMarketingRecipients(workspaceId:string,filter:MarketingAudienceFilter,
  options:{email?:string;after?:string}={}):SQL{
  const {account,related:linked}=marketingAudienceFilter.parse(filter);
  const needsAccount=!!(account||linked);
  return sql`SELECT DISTINCT c.email AS email
    FROM ${contacts} c JOIN ${sync} s ON s.workspace_id=c.workspace_id AND s.generation=c.generation
    ${needsAccount?sql`JOIN ${accounts} a ON a.workspace_id=c.workspace_id AND a.generation=c.generation AND a.id=c.account_id`:sql.empty()}
    WHERE c.workspace_id=${workspaceId}::uuid AND s.state='ready' AND ${fresh}
      AND c.email IS NOT NULL AND c.eligible
      ${options.email!==undefined?sql`AND c.email=${options.email.trim().toLowerCase()}`:sql.empty()}
      ${options.after?sql`AND c.email>${options.after}`:sql.empty()}
      ${account?sql`AND a.fields->>${account.field} = ${account.value}`:sql.empty()}
      ${linked?sql`AND EXISTS (SELECT 1 FROM ${related} r WHERE r.workspace_id=c.workspace_id
        AND r.generation=c.generation AND r.account_id=c.account_id AND r.fields->>${linked.field} = ${linked.value})`:sql.empty()}
      AND NOT EXISTS (SELECT 1 FROM ${contacts} blocked WHERE blocked.workspace_id=c.workspace_id
        AND blocked.generation=c.generation AND blocked.email=c.email AND NOT blocked.eligible)
      AND NOT EXISTS (SELECT 1 FROM ${emailSuppressions} b WHERE b.workspace_id=c.workspace_id AND b.email=c.email)`;
}

export async function marketingRecipientEligible(db:Db,workspaceId:string,filter:MarketingAudienceFilter,email:string){
  const address=suppressedAddress.safeParse(email);
  if(!address.success)return false;
  const rows=await db.execute(eligibleMarketingRecipients(workspaceId,filter,{email:address.data}));
  return rows.length>0;
}

export function marketingAudiencePage(db:Db,workspaceId:string,filter:MarketingAudienceFilter,after?:string){
  if(after&&!suppressedAddress.safeParse(after).success)throw new ApiError(400,'Invalid audience cursor.');
  return db.transaction(async tx=>{
    const status=await marketingAudienceStatus(tx,workspaceId);
    if(status.state!=='ready')return {status,total:0,emails:[] as string[],next:null as string|null};
    const criteria=marketingAudienceFilter.parse(filter);
    if(criteria.account&&!status.mapping?.accountFields.includes(criteria.account.field)||
      criteria.related&&!status.mapping?.related?.fields.includes(criteria.related.field)){
      throw new ApiError(400,'Select a field in the current Salesforce audience mapping.');
    }
    const [total]=await tx.execute<{count:number}>(sql`SELECT count(*)::int AS count FROM (
      ${eligibleMarketingRecipients(workspaceId,criteria)}) audience`);
    const rows=await tx.execute<{email:string}>(sql`${eligibleMarketingRecipients(workspaceId,criteria,{after})}
      ORDER BY email LIMIT ${pageSize+1}`);
    return {status,total:total.count,emails:rows.slice(0,pageSize).map(row=>row.email),
      next:rows.length>pageSize?rows[pageSize-1].email:null};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

async function writePage(tx:Tx,workspaceId:string,generation:string,page:SalesforceAudiencePage){
  if(!page.rows.length)return;
  const base={workspaceId,generation};
  // A repeated provider ID in one generation signals an incomplete/unstable scan. Never
  // certify it even if the reported total number of rows otherwise appears correct.
  let saved:{id:string}[];
  if(page.kind==='contacts'){
    saved=await tx.insert(contacts).values(page.rows.map(row=>({...base,...row}))).onConflictDoUpdate({
      target:[contacts.workspaceId,contacts.id],set:{generation,email:sql`excluded.email`,
        accountId:sql`excluded.account_id`,eligible:sql`excluded.eligible`},setWhere:ne(contacts.generation,generation),
    }).returning({id:contacts.id});
  }else if(page.kind==='accounts'){
    saved=await tx.insert(accounts).values(page.rows.map(row=>({...base,...row}))).onConflictDoUpdate({
      target:[accounts.workspaceId,accounts.id],set:{generation,fields:sql`excluded.fields`},setWhere:ne(accounts.generation,generation),
    }).returning({id:accounts.id});
  }else{
    saved=await tx.insert(related).values(page.rows.map(row=>({...base,...row}))).onConflictDoUpdate({
      target:[related.workspaceId,related.id],set:{generation,accountId:sql`excluded.account_id`,fields:sql`excluded.fields`},
      setWhere:ne(related.generation,generation),
    }).returning({id:related.id});
  }
  if(saved.length!==page.rows.length)throw new Error('Duplicate source ID in this Salesforce audience refresh.');
}

export async function syncConfiguredMarketingAudience(db:Db,workspaceId:string,env:Record<string,string|undefined>){
  const previous=await marketingAudienceStatus(db,workspaceId);
  let source:SalesforceAudienceSource;
  try{
    source=salesforceAudienceSourceFromEnv(env);
  }catch(error){
    // A configuration error happens before a refresh can claim its new generation.
    // Invalidate only the snapshot we saw, preserving any concurrent operator's refresh.
    if(previous.generation&&previous.state==='ready'){
      await db.update(sync).set({state:'failed',progressedAt:sql`now()`}).where(and(
        eq(sync.workspaceId,workspaceId),eq(sync.generation,previous.generation),eq(sync.state,'ready')));
    }
    throw error;
  }
  return syncMarketingAudience(db,workspaceId,source);
}

export async function syncMarketingAudience(db:Db,workspaceId:string,source:SalesforceAudienceSource){
  const generation=crypto.randomUUID();
  const mapped=source.mapping,relation=mapped.related;
  const sourceKey=createHash('sha256').update(JSON.stringify([source.origin?new URL(source.origin).origin:'fixture',
    mapped.consentField,[...mapped.accountFields].sort(),relation?[relation.object,relation.accountField,[...relation.fields].sort()]:null])).digest('hex');
  const values={generation,sourceKey,state:'syncing' as const,mapping:source.mapping,startedAt:sql`now()`,
    progressedAt:sql`now()`,completedAt:null,contactCount:0,accountCount:0,relatedCount:0};
  const [claim]=await db.insert(sync).values({workspaceId,...values}).onConflictDoUpdate({target:sync.workspaceId,set:values,
    setWhere:sql`${sync.state} <> 'syncing' OR ${sync.progressedAt} < now() - interval '5 minutes'`})
    .returning({generation:sync.generation});
  if(!claim)throw new ApiError(409,'A Salesforce audience refresh is already in progress.');
  const owns=and(eq(sync.workspaceId,workspaceId),eq(sync.generation,generation),eq(sync.state,'syncing'));
  try{
    for await(const page of source.pages()){
      if(page.rows.length>2000)throw new Error('The Salesforce audience page exceeded its bound.');
      await db.transaction(async tx=>{
        const [active]=await tx.select({id:sync.workspaceId}).from(sync).where(owns).for('update');
        if(!active)throw new ApiError(409,'A newer Salesforce audience refresh already started.');
        await writePage(tx,workspaceId,generation,page);
        const column={contacts:sync.contactCount,accounts:sync.accountCount,related:sync.relatedCount}[page.kind];
        const property={contacts:'contactCount',accounts:'accountCount',related:'relatedCount'}[page.kind];
        await tx.update(sync).set({progressedAt:sql`now()`,[property]:sql`${column}+${page.rows.length}`}).where(owns);
      }).catch(error=>{
        if(error instanceof ApiError)throw error;
        // Driver errors can include the imported addresses in SQL parameters.
        throw new Error('Could not store the Salesforce audience page. Check provider IDs and database availability.');
      });
    }
    await db.transaction(async tx=>{
      const [active]=await tx.select({id:sync.workspaceId}).from(sync).where(owns).for('update');
      if(!active)throw new ApiError(409,'A newer Salesforce audience refresh already started.');
      for(const table of [contacts,accounts,related]){
        await tx.delete(table).where(and(eq(table.workspaceId,workspaceId),ne(table.generation,generation)));
      }
      await tx.update(sync).set({state:'ready',completedAt:sql`now()`,progressedAt:sql`now()`}).where(owns);
    });
  }catch(error){
    await db.update(sync).set({state:'failed',progressedAt:sql`now()`}).where(owns);
    throw error;
  }
  return marketingAudienceStatus(db,workspaceId);
}
