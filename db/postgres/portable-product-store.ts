import {and,asc,count,eq,isNotNull,isNull,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {z} from 'zod';
import {productData,type productMutation} from '../../lib/commerce';
import {portableProductExportLimit,type PortableProductFilters,type PortableProductPage,type PortableProductQuery} from '../../lib/portable-products';
import {lockRecordWorkspace} from './private-workspace-store';
import {portableProducts as products} from './portable-product-schema';
import {privateWorkspaces} from './workspace-schema';

const publicColumns={id:products.id,revision:products.revision,data:products.data,archivedAt:products.archivedAt,
  createdAt:products.createdAt,updatedAt:products.updatedAt};
const productName=sql`lower(${products.data}->>'name')`;
function matchingProducts(actorId:string,filters:PortableProductFilters){
  return and(eq(privateWorkspaces.ownerId,actorId),filters.archived==='true'?isNotNull(products.archivedAt):isNull(products.archivedAt),
    filters.billingFrequency?sql`${products.data}->>'billingFrequency'=${filters.billingFrequency}`:undefined,
    filters.q?sql`(strpos(${productName},lower(${filters.q}))>0 OR strpos(lower(${products.data}->>'sku'),lower(${filters.q}))>0)`:undefined);
}
function product({data,...row}:Omit<typeof products.$inferSelect,'workspaceId'>){
  return {...data,...row};
}

export function readPortableProduct(db:PostgresJsDatabase,actorId:string,id:string){
  return db.select(publicColumns).from(products).innerJoin(privateWorkspaces,eq(products.workspaceId,privateWorkspaces.id))
    .where(and(eq(privateWorkspaces.ownerId,actorId),eq(products.id,id))).limit(1)
    .then(([row])=>row?product(row):null);
}

export function listPortableProducts(db:PostgresJsDatabase,actorId:string,query:PortableProductQuery):Promise<PortableProductPage>{
  return db.transaction(async tx=>{
    const match=matchingProducts(actorId,query);
    const [{total}]=await tx.select({total:count()}).from(products)
      .innerJoin(privateWorkspaces,eq(products.workspaceId,privateWorkspaces.id)).where(match);
    const size=25,page=Math.min(query.page??0,Math.max(0,Math.ceil(total/size)-1));
    const rows=await tx.select(publicColumns).from(products).innerJoin(privateWorkspaces,eq(products.workspaceId,privateWorkspaces.id))
      .where(match).orderBy(asc(productName),asc(products.id)).limit(size).offset(page*size);
    return {items:rows.map(product),total,page,size};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export async function listPortableProductsForExport(db:PostgresJsDatabase,actorId:string,filters:PortableProductFilters){
  const rows=await db.select(publicColumns).from(products)
    .innerJoin(privateWorkspaces,eq(products.workspaceId,privateWorkspaces.id))
    .where(matchingProducts(actorId,filters)).orderBy(asc(productName),asc(products.id))
    .limit(portableProductExportLimit+1);
  return rows.length<=portableProductExportLimit?rows.map(product):null;
}

export function savePortableProduct(db:PostgresJsDatabase,actorId:string,input:z.output<typeof productMutation>){
  return db.transaction(async tx=>{
    const creating=input.action==='save'&&input.revision===0;
    const workspaceId=await lockRecordWorkspace(tx,actorId,creating,undefined,undefined,true);
    if(!workspaceId)return {error:'missing'} as const;
    const target=and(eq(products.workspaceId,workspaceId),eq(products.id,input.id));
    const [current]=await tx.select(publicColumns).from(products).where(target).for('update');
    const now=new Date().toISOString();
    if(creating){
      if(current){
        if(JSON.stringify(productData.parse(current.data))!==JSON.stringify(input.data))return {error:'conflict'} as const;
        return {ok:true,id:current.id,revision:current.revision};
      }
      await tx.insert(products).values({id:input.id,workspaceId,data:input.data,revision:1,createdAt:now,updatedAt:now});
      return {ok:true,id:input.id,revision:1};
    }
    if(!current)return {error:'missing'} as const;
    if(current.revision!==input.revision||current.revision>=2147483647)return {error:'conflict'} as const;
    const change=input.action==='archive'?{archivedAt:input.archived?now:null}:{data:input.data};
    const revision=current.revision+1;
    await tx.update(products).set({...change,revision,updatedAt:now}).where(target);
    return {ok:true,id:input.id,revision};
  });
}
