import {z} from 'zod';
import {readDealPipelines,saveDealPipeline} from '../db/postgres/deal-pipeline-store';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {builtinPipeline,portablePipelineWrite} from '../lib/portable-deal-pipelines';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const scope=z.object({workspaceId:z.string().guid("Invalid uuid").optional()}).strict();
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const failures={
  missing:{error:'Pipeline not found.',status:404},
  stale:{error:'Pipeline settings changed. Refresh before saving again.',status:409},
  duplicate:{error:'A pipeline already has that name.',status:409},
  limit:{error:'This workspace already has 10 custom pipelines.',status:409},
  stages:{error:'Keep all existing stages. Add new stages without an ID.',status:400},
  properties:{error:'Choose custom Deal properties from this workspace.',status:400},
} as const;

async function route(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    const query=scope.safeParse(Object.fromEntries(params));
    if(!query.success||params.size!==new Set(params.keys()).size)return json({error:'Invalid pipeline query.'},400);
    const db=portableDb(),workspaceId=query.data.workspaceId;
    if(request.method!=='POST'){
      if(workspaceId&&!await sharedWorkspaceGrant(db,user.userId,workspaceId))return json({error:'Workspace not found.'},404);
      const pipelines=await readDealPipelines(db,user.userId,workspaceId);
      return json({pipelines:[builtinPipeline,...pipelines]});
    }
    if(workspaceId)return json({error:'Only the workspace owner can change pipeline settings.'},403);
    const text=await readBoundedRequestText(request,16_384);
    const input=portablePipelineWrite.safeParse(text===null?undefined:JSON.parse(text));
    if(!input.success)return json({error:input.error.issues[0]?.message||'Check pipeline settings.'},400);
    const saved=await saveDealPipeline(db,user.userId,input.data);
    if('error' in saved){
      const {error,status}=failures[saved.error];
      return json({error},status);
    }
    return json(saved,'id' in input.data?200:201);
  }catch(error){
    if(error instanceof SyntaxError)return json({error:'Check pipeline settings.'},400);
    console.error('Portable pipeline request failed.');
    return json({error:'Could not finish this pipeline request.'},500);
  }
}
export {route as GET,route as POST};
