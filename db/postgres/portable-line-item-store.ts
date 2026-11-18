import {and,eq,inArray,isNull} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {z} from 'zod';
import {amountFromLines,lineItemTotals,revenueTotals,type LineSet,type lineSetInput} from '../../lib/commerce';
import {deals} from './deal-schema';
import {saveDealInTransaction} from './deal-store';
import {portableLineItemSets as sets} from './portable-line-item-schema';
import {portableProducts as products} from './portable-product-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces} from './workspace-schema';
import {activeDeal} from './deal-visibility';

const dealFields={workspaceId:deals.workspaceId,id:deals.id,revision:deals.revision,updatedAt:deals.updatedAt,data:deals.data};

export function readPortableLineItems(db:PostgresJsDatabase,actorId:string,dealId:string):Promise<LineSet|null>{
  return db.transaction(async tx=>{
    const [deal]=await tx.select(dealFields).from(deals).innerJoin(privateWorkspaces,eq(deals.workspaceId,privateWorkspaces.id))
      .where(and(eq(privateWorkspaces.ownerId,actorId),eq(deals.id,dealId),activeDeal));
    if(!deal)return null;
    const [set]=await tx.select().from(sets).where(and(eq(sets.workspaceId,deal.workspaceId),eq(sets.dealId,dealId)));
    const items=set?.items??[];
    return {items,revision:set?.revision??0,amountMetric:set?.amountMetric??'tcv',
      totals:lineItemTotals(items),revenue:revenueTotals(items),
      deal:{id:deal.id,name:deal.data.name,amount:deal.data.amount,updatedAt:deal.updatedAt}};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export function savePortableLineItems(db:PostgresJsDatabase,actorId:string,input:z.output<typeof lineSetInput>){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,false,undefined,undefined,true);
    if(!workspaceId)return 'missing';
    const [deal]=await tx.select(dealFields).from(deals).where(and(eq(deals.workspaceId,workspaceId),eq(deals.id,input.dealId),activeDeal)).for('update');
    if(!deal)return 'missing';
    const target=and(eq(sets.workspaceId,workspaceId),eq(sets.dealId,deal.id));
    const [current]=await tx.select().from(sets).where(target).for('update');
    const revision=current?.revision??0;
    if(input.revision!==revision||revision>=2147483647||deal.updatedAt!==input.expectedUpdatedAt||deal.data.amount!==input.expectedAmount)return 'stale';
    const links=new Map(current?.items.map(line=>[line.id,line.productId]));
    const newLinks=input.items.filter(line=>line.productId&&links.get(line.id)!==line.productId);
    if(newLinks.length){
      const catalog=await tx.select({id:products.id,revision:products.revision}).from(products).where(and(
        eq(products.workspaceId,workspaceId),isNull(products.archivedAt),inArray(products.id,newLinks.map(line=>line.productId!))));
      const versions=new Map(catalog.map(row=>[row.id,row.revision]));
      if(newLinks.some(line=>versions.get(line.productId!)!==line.productRevision))return 'product_changed';
    }
    const amountMetric=input.amountMetric??current?.amountMetric??'net';
    if(input.updateAmount){
      const amount=amountFromLines(input.items,amountMetric)/100;
      if(deal.data.amount!==amount){
        const result=await saveDealInTransaction(tx,actorId,{action:'save',kind:'deals',
          id:deal.id,expectedRevision:deal.revision,data:{...deal.data,amount}});
        if('error' in result)throw Error('Could not update the deal amount.');
      }
    }
    const change={revision:revision+1,amountMetric,items:input.items};
    await tx.insert(sets).values({workspaceId,dealId:deal.id,...change})
      .onConflictDoUpdate({target:[sets.workspaceId,sets.dealId],set:change});
    return 'ok';
  });
}
