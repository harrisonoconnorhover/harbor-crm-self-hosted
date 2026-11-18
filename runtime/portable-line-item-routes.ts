import {z} from 'zod';
import {readPortableLineItems,savePortableLineItems} from '../db/postgres/portable-line-item-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {lineSetInput} from '../lib/commerce';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const id=z.string().guid("Invalid uuid");
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

async function lineItems(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method==='POST'){
      if(params.size)return json({error:'Check the line item request.'},400);
      let body:unknown;
      try{
        const text=await readBoundedRequestText(request,600_000);
        if(text===null)return json({error:'Use at most 100 line items with shorter descriptions.'},413);
        body=JSON.parse(text);
      }catch{return json({error:'Supply valid JSON.'},400);}
      const input=lineSetInput.safeParse(body);
      if(!input.success||!id.safeParse(input.data.dealId).success)return json({error:'Check line item fields.'},400);
      const result=await savePortableLineItems(db,user.userId,input.data);
      if(result==='stale')return json({error:'The deal or its line items changed. Reload before saving.'},409);
      if(result==='product_changed')return json({error:'A new product was changed, archived or unavailable. Choose it again from the catalog.'},409);
      if(result==='missing')return json({error:'Deal not found.'},404);
      return json({ok:true});
    }
    const dealId=id.safeParse(params.get('dealId'));
    if(params.size!==1||!dealId.success)return json({error:'Choose a deal.'},400);
    const lines=await readPortableLineItems(db,user.userId,dealId.data);
    return lines?json(lines):json({error:'Deal not found.'},404);
  }catch{return json({error:'Could not save or load line items.'},500);}
}

export {lineItems as GET,lineItems as POST};
