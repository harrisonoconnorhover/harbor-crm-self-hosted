import {workspaceHelpArticles,workspaceHelpTopics} from '../db/postgres/help-center-store';
import {helpArticleSearch,publicTopic} from '../lib/help-center';
import {z} from 'zod';
import {changeInboxConversation,finishInboxReply,readTeamInbox,findInboxSnippetNames,readInboxSnippets,receiveInboxMessage,reserveInboxReply,writeInboxSnippet} from '../db/postgres/team-inbox-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {sharedRecordWriteScope} from '../lib/portable-workspace-access';
import {inboxRead,inboxSnippetRead,inboxWrite} from '../lib/team-inbox';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {requestSessionHash} from './portable-identity';
import {authorizeIncoming,configuredInbox,deliverInboxReply,parseInbound} from './portable-team-inbox-provider';

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'private, no-store'}});
function failure(error:unknown){
  if(error instanceof ApiError)return json({error:error.message},error.status);
  if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:'Check the mailbox request fields.'},400);
  return json({error:'Could not confirm the inbox change. Refresh the conversation to see its current state.'},503);
}
async function body(request:Request,limit:number){
  const raw=await readBoundedRequestText(request,limit);
  if(raw===null)throw new ApiError(413,'Message exceeds the inbox size limit.');
  return JSON.parse(raw);
}

export async function inbound(request:Request){
  try{
    authorizeIncoming(request.headers.get('authorization'));
    const message=parseInbound(await body(request,10*1024*1024));
    return json(await receiveInboxMessage(portableDb(),message));
  }catch(error){return failure(error);}
}

async function workspaceInbox(request:Request){
  try{
    const identity=await portableApiIdentity(request);
    if(identity instanceof Response)return identity;
    const url=new URL(request.url),params=url.searchParams,query=Object.fromEntries(params);
    if(params.size!==Object.keys(query).length)throw new ApiError(400,'Invalid inbox query.');
    const db=portableDb();
    if(request.method==='GET'||request.method==='HEAD'){
      if(params.get('articles')==='topics'){
        const {workspaceId,afterTopic}=helpArticleSearch.pick({workspaceId:true}).extend({articles:z.literal('topics'),afterTopic:publicTopic.optional()}).parse(query);
        return json(await workspaceHelpTopics(db,identity.userId,workspaceId,afterTopic));
      }
      if(params.has('articles')){
        const {workspaceId,q,after,topic}=helpArticleSearch.extend({articles:z.literal('1')}).parse(query);
        return json(await workspaceHelpArticles(db,identity.userId,workspaceId,{q,after,topic}));
      }
      if(params.has('snippets')){
        const lookup=inboxSnippetRead.parse(query);
        return json(lookup.snippets==='names'?await findInboxSnippetNames(db,identity.userId,lookup.workspaceId,lookup.q):
          await readInboxSnippets(db,identity.userId,lookup.workspaceId,lookup.id));
      }
      return json(await readTeamInbox(db,identity,inboxRead.parse(query),request.method!=='HEAD'));
    }
    if(request.headers.get('origin')!==url.origin)throw new ApiError(403,'Open this conversation before editing.');
    const sessionHash=await requestSessionHash(request.headers);
    if(!sessionHash)throw new ApiError(403,'Sign in again.');
    const actor={...identity,sessionHash},shared=params.size?sharedRecordWriteScope.parse(query):undefined;
    const input=inboxWrite.parse(await body(request,96*1024));
    if(input.action==='save_snippet'||input.action==='delete_snippet'){
      if(shared)throw new ApiError(403,'Only the workspace owner manages team replies.');
      return json(await writeInboxSnippet(db,actor,input));
    }
    if(input.action!=='reply')return json(await changeInboxConversation(db,actor,input,shared));
    let token:string|undefined;
    const reserved=await reserveInboxReply(db,actor,input,shared,(workspaceId,mailbox)=>{
      token=configuredInbox(workspaceId,mailbox)?.token;
      if(!token)throw new ApiError(409,'Sending is off for this mailbox. Ask your Harbor administrator to connect its sender.');
    });
    const result={id:input.id,replyId:input.replyId};
    if(!reserved.dispatch)return json({...result,state:reserved.state});
    if(!token)throw new ApiError(503,'Check the reply status before sending again.');
    const receipt=await deliverInboxReply(token,reserved,input.body);
    await finishInboxReply(db,{workspaceId:reserved.workspaceId,replyId:input.replyId,...receipt});
    return json({...result,...receipt});
  }catch(error){return failure(error);}
}
export {workspaceInbox as GET,workspaceInbox as HEAD,workspaceInbox as POST};
