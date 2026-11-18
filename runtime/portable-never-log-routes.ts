import {z} from 'zod';
import {addPortableNeverLog,portableNeverLogPage,removePortableNeverLog} from '../db/postgres/portable-never-log-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {neverLogInput} from '../lib/email/never-log';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const page=z.object({query:z.string().trim().max(256).default(''),offset:z.coerce.number().int().min(0).max(500).default(0)}).strict();
const deletion=z.object({id:z.string().guid("Invalid uuid")}).strict();
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

async function route(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    if(user.guest)return json({error:'Only the private workspace owner can manage Never Log rules.'},403);
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method==='GET'||request.method==='HEAD'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid rule search.'},400);
      const {query,offset}=page.parse(Object.fromEntries(params));
      return json(await portableNeverLogPage(db,user.userId,query,offset));
    }
    if(params.size)return json({error:'Invalid rule request.'},400);
    const body=await readBoundedRequestText(request,4096);
    if(body===null)return json({error:'Rule request is too large.'},413);
    const input:unknown=JSON.parse(body);
    if(request.method==='DELETE'){
      await removePortableNeverLog(db,user.userId,deletion.parse(input).id);
      return json({removed:true});
    }
    const saved=await addPortableNeverLog(db,user.userId,neverLogInput.parse(input));
    return saved?json(saved):json({error:'The rule could not be added. Use a new rule ID and keep the list under 500 entries.'},409);
  }catch(error){
    if(error instanceof z.ZodError)return json({error:error.issues[0]?.message??'Check the rule details.'},400);
    if(error instanceof SyntaxError)return json({error:'Send valid JSON.'},400);
    return json({error:'Could not manage Never Log rules. Try again.'},503);
  }
}

export {route as GET,route as POST,route as DELETE};
