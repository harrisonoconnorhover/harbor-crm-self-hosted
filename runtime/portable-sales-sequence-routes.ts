import {z} from 'zod';
import {ApiError} from '../lib/api-error';
import {salesSequenceCommand,salesSequenceQuery} from '../lib/portable-sales-sequences';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {readSalesSequences,writeSalesSequences} from '../db/postgres/sales-sequence-store';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {portableGmailOwner} from './portable-gmail-config';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

export async function salesSequenceRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const db=portableDb();
    const sender=portableGmailOwner()===user.email.toLowerCase()?user.email.toLowerCase():null;
    const params=new URL(request.url).searchParams;
    if(request.method==='GET'||request.method==='HEAD'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Use each sequence filter once.'},400);
      const result=await readSalesSequences(db,user,salesSequenceQuery.parse(Object.fromEntries(params)),request.method!=='HEAD');
      return json({...result,readiness:{sender}});
    }
    if(params.size)return json({error:'Use the sequence command body for edits.'},400);
    const body=await readBoundedRequestText(request,256*1024);
    if(body===null)return json({error:'This sequence is too large.'},413);
    const command=salesSequenceCommand.parse(JSON.parse(body));
    return json(await writeSalesSequences(db,user,command,sender));
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof SyntaxError||error instanceof z.ZodError)return json({error:'Check the sequence fields and try again.'},400);
    return json({error:'Could not confirm the sequence request. Refresh before trying again.'},503);
  }
}
