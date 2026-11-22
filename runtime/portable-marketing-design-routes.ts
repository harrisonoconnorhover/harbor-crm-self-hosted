import {z} from 'zod';
import {listMarketingDesigns,readMarketingDesign,saveMarketingDesign} from '../db/postgres/marketing-design-store';
import {marketingWorkspaceForOwner} from '../db/postgres/marketing-workspace-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {marketingDesignAction,marketingDesignBodyLimit,marketingDesignQuery,renderNativeDesignSave} from '../lib/marketing-design';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {beefreeConfigured,createBeefreeSession} from './portable-marketing-design-auth';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
async function route(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    if(user.guest)throw new ApiError(403,'Only the marketing workspace owner can manage email designs.');
    const db=portableDb();
    const workspaceId=await marketingWorkspaceForOwner(db,user.userId);
    const client={HARBOR_BEEFREE_CLIENT_ID:process.env.HARBOR_BEEFREE_CLIENT_ID,HARBOR_BEEFREE_CLIENT_SECRET:process.env.HARBOR_BEEFREE_CLIENT_SECRET};
    const params=new URL(request.url).searchParams;
    if(request.method==='GET'||request.method==='HEAD'){
      if(params.size!==new Set(params.keys()).size)throw new ApiError(400,'Invalid design query.');
      const input=marketingDesignQuery.parse(Object.fromEntries(params));
      if('id' in input)return json({design:await readMarketingDesign(db,workspaceId,user.userId,input.id)});
      return json({...await listMarketingDesigns(db,workspaceId,user.userId,input.after),configured:beefreeConfigured(client)});
    }
    if(params.size)throw new ApiError(400,'Send design changes in the request body.');
    const text=await readBoundedRequestText(request,marketingDesignBodyLimit);
    if(text===null)throw new ApiError(413,'The design is too large. Reduce the email or its embedded images.');
    const input=marketingDesignAction.parse(JSON.parse(text));
    if(input.action==='session')return json(await createBeefreeSession(workspaceId,client));
    const design=input.action==='saveNative'?renderNativeDesignSave(input):input;
    return json({design:await saveMarketingDesign(db,workspaceId,user.userId,design)});
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:'Check the design name, subject and content.'},400);
    return json({error:'Could not load or save this design. Try again.'},503);
  }
}
export {route as GET,route as POST};
