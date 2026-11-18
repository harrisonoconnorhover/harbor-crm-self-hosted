import {withPortableNavigation} from './portable-navigation';
import {notFound} from 'next/navigation';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {listPortableProducts,readPortableProduct} from '../db/postgres/portable-product-store';
import {safeReturnPath} from '../lib/identity';
import {portableProductQuery} from '../lib/portable-products';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {PortableProducts} from './portable-products-ui';

export default async function ProductsPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const {add,id:requestedId,...params}=await searchParams;
  const query=portableProductQuery.safeParse(params);
  const selection=portableProductQuery.safeParse({id:requestedId});
  if(!query.success||!selection.success||add!==undefined&&(add!=='1'||selection.data.id))notFound();
  const id=selection.data.id;
  const returnParams=new URLSearchParams();
  if(add==='1')returnParams.set('add',add);
  if(id)returnParams.set('id',id);
  for(const [key,value] of Object.entries(query.data)){
    if(value!==undefined)returnParams.set(key,String(value));
  }
  const returnPath=safeReturnPath('/products'+(returnParams.size?'?'+returnParams:''));
  const user=await requireChatGPTUser(returnPath==='/'?'/products':returnPath);
  if(portableWorkspaceGuest(user.email))notFound();
  const db=portableDb();
  const record=id?await readPortableProduct(db,user.userId,id):undefined;
  if(id&&!record)notFound();
  const page=!record&&add!=='1'?await listPortableProducts(db,user.userId,query.data):undefined;
  return withPortableNavigation(user.email,<PortableProducts key={record?record.id+':'+record.revision:add?'add':'list'} email={user.email} product={record??undefined} page={page} query={query.data}/>);
}
