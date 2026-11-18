import {z} from 'zod';
import {admitManualNoteBatch,readManualNoteBatch} from '../db/postgres/manual-workflow-batch-store';
import {admitManualWorkflowRun} from '../db/postgres/manual-workflow-store';
import {managePortableWorkflow,readPortableWorkflows,readPortableWorkflowRuns,reviewWorkflowCapacitySkip} from '../db/postgres/workflow-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableManualBatchRead,portableManualWorkflowBatch,portableManualWorkflowRun,portableWorkflowAction,portableWorkflowCapacityReview,portableWorkflowRunRead} from '../lib/portable-workflows';
import {portableApiIdentity} from './portable-api-identity';
import {portableWorkflowGmailOwner} from './portable-gmail-config';
import {portableCodeAvailable} from './portable-code-config';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

async function route(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method!=='POST'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid workflow query.'},400);
      if(params.has('batchId')){
        const {batchId}=portableManualBatchRead.parse(Object.fromEntries(params));
        const batch=await readManualNoteBatch(db,user.userId,batchId);
        return batch?json({batch}):json({error:'Workflow batch not found.'},404);
      }
      const {at,id,...filters}=portableWorkflowRunRead.parse(Object.fromEntries(params));
      const after=at!==undefined&&id!==undefined?{at,id}:undefined;
      const [workflows,history]=await Promise.all([readPortableWorkflows(db,user.userId),
        readPortableWorkflowRuns(db,user.userId,{after,...filters})]);
      return json({workflows,...history});
    }
    if(params.size)return json({error:'Only the workspace owner can change these workflows.'},403);
    const text=await readBoundedRequestText(request,32_000);
    if(text===null)return json({error:'Workflow settings are too large.'},413);
    const raw=JSON.parse(text);
    if(raw?.action==='reviewQueueFullRun'){
      const {id}=portableWorkflowCapacityReview.parse(raw);
      const receipt=await reviewWorkflowCapacitySkip(db,user.userId,id);
      return receipt?json({receipt}):json({error:'Workflow run not found.'},404);
    }
    if(raw?.action==='runContactBatch'){
      const {batch,created}=await admitManualNoteBatch(db,user.userId,portableManualWorkflowBatch.parse(raw));
      return json({batch},created?201:200);
    }
    if(raw?.action==='runContact'){
      const {run,created}=await admitManualWorkflowRun(db,user.userId,portableManualWorkflowRun.parse(raw),portableCodeAvailable());
      return json({run},created?201:200);
    }
    await managePortableWorkflow(db,user.userId,portableWorkflowAction.parse(raw),portableWorkflowGmailOwner()===user.email.toLowerCase(),portableCodeAvailable());
    return json({ok:true});
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof SyntaxError||error instanceof z.ZodError)return json({error:'Check the workflow fields and stage.'},400);
    console.error('Portable workflow request failed.');
    return json({error:'Could not confirm this workflow change. Reload before trying again.'},503);
  }
}

export {route as GET,route as POST};
