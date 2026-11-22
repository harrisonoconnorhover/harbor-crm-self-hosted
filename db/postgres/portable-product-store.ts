import {readCommerceResult,type RecordAccessActor} from './record-access-store';
import {matchesCommerceSearch,productSearchFields} from './commerce-search';
import {and,asc,count,desc,eq,inArray,isNotNull,isNull,or,sql} from 'drizzle-orm';
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
// Mapped products retain their subscriber history even after a catalog change to one-time billing.
function subscriptionPlanFilter(mappedIds?:string[]){
  if(!mappedIds)return undefined;
  return or(sql`${products.data}->>'billingFrequency'<>'one_time'`,mappedIds.length?inArray(products.id,mappedIds):undefined);
}
function matchingProducts(actorId:string,filters:PortableProductFilters,subscriptionPlanIds?:string[]){
  return and(eq(products.workspaceId,sql`(SELECT ${privateWorkspaces.id} FROM ${privateWorkspaces} WHERE ${privateWorkspaces.ownerId}=${actorId})`),
    subscriptionPlanFilter(subscriptionPlanIds),
    filters.archived==='true'?isNotNull(products.archivedAt):isNull(products.archivedAt),
    filters.billingFrequency?sql`${products.data}->>'billingFrequency'=${filters.billingFrequency}`:undefined,
    matchesCommerceSearch(productSearchFields(products.data),filters.q));
}
function product({data,...row}:Omit<typeof products.$inferSelect,'workspaceId'>){
  return {...data,...row};
}

export function readPortableProduct(db:PostgresJsDatabase,actor:RecordAccessActor,includeBody:boolean,id:string,workspaceId?:string,subscriptionPlanIds?:string[]){
  return readCommerceResult(db,actor,'products',includeBody&&'detail',async tx=>{
    return tx.select(publicColumns).from(products).innerJoin(privateWorkspaces,eq(products.workspaceId,privateWorkspaces.id))
      .where(and(eq(privateWorkspaces.ownerId,actor.userId),workspaceId?eq(products.workspaceId,workspaceId):undefined,eq(products.id,id),subscriptionPlanFilter(subscriptionPlanIds))).limit(1)
      .then(([row])=>row?product(row):null);
  },result=>result?[result.id]:[]);
}

export function listPortableProducts(db:PostgresJsDatabase,actor:RecordAccessActor,includeBody:boolean,query:PortableProductQuery,subscriptionPlanIds?:string[]):Promise<PortableProductPage>{
  return readCommerceResult(db,actor,'products',includeBody&&'list',async tx=>{
    const match=matchingProducts(actor.userId,query,subscriptionPlanIds);
    const size=25,backward=Boolean(query.before),cursor=query.after??query.before;
    let total:number|null=null,page:number|null=null;
    const order=backward?desc:asc;
    let boundary;
    if(cursor){
      const name=Buffer.from(cursor.slice(37),'base64url').toString('utf8'),id=cursor.slice(0,36);
      boundary=backward?sql`(${productName},${products.id}) < (${name},${id}::uuid)`:
        sql`(${productName},${products.id}) > (${name},${id}::uuid)`;
    }else{
      const [counts]=await tx.select({total:count()}).from(products).where(match);
      total=counts.total;
      page=Math.min(query.page??0,Math.max(0,Math.ceil(total/size)-1));
    }
    const rows=await tx.select({record:publicColumns,sortName:productName.mapWith(String)}).from(products)
      .where(and(match,boundary)).orderBy(order(productName),order(products.id)).limit(size+1).offset((page??0)*size);
    const more=rows.length>size,visible=rows.slice(0,size);
    if(backward)visible.reverse();
    function position(row:typeof rows[number]|undefined){
      return row?row.record.id+'.'+Buffer.from(row.sortName).toString('base64url'):null;
    }
    return {items:visible.map(({record})=>product(record)),total,page,size,
      previous:(backward?more:Boolean(query.after)||(page??0)>0)?position(visible[0]):null,
      next:(backward||more)?position(visible.at(-1)):null};
  },result=>result.items.map(item=>item.id));
}

export async function listPortableProductsForExport(db:PostgresJsDatabase,actorId:string,filters:PortableProductFilters){
  const rows=await db.select(publicColumns).from(products)
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
