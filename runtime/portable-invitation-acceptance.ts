type WorkspaceRequest=(path:string,init:RequestInit)=>Promise<Response>;
type WorkspaceReply={sharedNext?:string|null;shared?:({id?:string}|null)[];incoming?:({id?:string}|null)[];error?:string};
type Acceptance={status:'accepted'}|{status:'denied'|'pending'|'unconfirmed';message:string};

type AdministrationScope={workspaceId:string;grantId:string};
const path=(scope?:AdministrationScope)=>scope?'/api/workspaces?'+new URLSearchParams({
  workspaceId:scope.workspaceId,grantId:scope.grantId,
}):'/api/workspaces';
const responseTimeoutMs=12_000;
const readReply=async(response:Response)=>await response.json().catch(()=>undefined) as WorkspaceReply|undefined;
async function hasAccess(request:WorkspaceRequest,body:WorkspaceReply|undefined,workspaceId:string){
  if(body?.shared?.some(workspace=>workspace?.id===workspaceId))return true;
  if(!body?.sharedNext)return false;
  // The accepted workspace can be beyond the account overview's first page.
  const response=await request('/api/workspaces?'+new URLSearchParams({joined:'1',current:workspaceId}),
    {cache:'no-store',signal:AbortSignal.timeout(responseTimeoutMs)});
  if(response.status===404)return false;
  if(!response.ok)throw Error('Could not confirm workspace access.');
  const page=await response.json() as {current?:{id:string}};
  if(page?.current?.id!==workspaceId)throw Error('Could not confirm workspace access.');
  return true;
}

export function requestWorkspaceChange(request:WorkspaceRequest,data:object,scope?:AdministrationScope){
  return request(path(scope),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),
    signal:AbortSignal.timeout(responseTimeoutMs)});
}

export async function readWorkspaceAccess<T>(request:WorkspaceRequest,signal?:AbortSignal,scope?:AdministrationScope):Promise<T>{
  const deadline=AbortSignal.timeout(responseTimeoutMs);
  const response=await request(path(scope),{cache:'no-store',signal:signal?AbortSignal.any([signal,deadline]):deadline});
  if(!response.ok)throw Error('Could not load workspace sharing.');
  return await response.json() as T;
}

export async function saveWorkspaceAccess<T>(request:WorkspaceRequest,data:object,scope?:AdministrationScope){
  try{
    const response=await requestWorkspaceChange(request,data,scope);
    if(response.ok)return {status:'saved' as const,sharing:await response.json() as T};
    if(response.status>=400&&response.status<500){
      const body=await readReply(response);
      return {status:'denied' as const,message:body?.error||'Could not update workspace sharing.',
        ...(scope&&response.status===403?{scopeLost:true}:{})};
    }
  }catch{}
  // A write can commit even if the reply is lost. Read once before offering another change.
  try{return {status:'refreshed' as const,sharing:await readWorkspaceAccess<T>(request,undefined,scope)};}
  catch{return {status:'unconfirmed' as const};}
}

export async function declineReviewedWorkspaceInvitation(request:WorkspaceRequest,id:string){
  const result=await saveWorkspaceAccess<WorkspaceReply>(request,{action:'decline_invite',id});
  if(result.status==='saved')return {status:'declined' as const};
  if(result.status==='denied')return result;
  // The link may also disappear after cancellation, expiry or replacement. A read cannot confirm why.
  return {status:'unconfirmed' as const,message:'Could not confirm the decline. Reload the invitation to check its current status.'};
}

export async function acceptReviewedWorkspaceInvitation(request:WorkspaceRequest,id:string,workspaceId:string,checkOnly:boolean):Promise<Acceptance>{
  let unavailableMessage:string|undefined;
  if(!checkOnly){
    let response:Response|undefined;
    try{response=await requestWorkspaceChange(request,{action:'accept_invite',id});}catch{}
    if(response?.ok){
      const body=await readReply(response);
      if(Array.isArray(body?.shared)){
        try{
          return await hasAccess(request,body,workspaceId)?{status:'accepted'}:
            {status:'denied',message:'Workspace access is unavailable. Refresh the sharing list.'};
        }catch{return {status:'unconfirmed',message:'Could not confirm workspace access. Check access again.'};}
      }
    }else if(response&&response.status>=400&&response.status<500){
      const body=await readReply(response);
      const message=typeof body?.error==='string'&&body.error?body.error:'Could not accept the invitation. Try again.';
      if(response.status!==404)return {status:'denied',message};
      unavailableMessage=message;
    }
  }

  // A lost reply or a second tab's 404 can follow a committed acceptance.
  try{
    const body=await readWorkspaceAccess<WorkspaceReply>(request);
    if(await hasAccess(request,body,workspaceId))return {status:'accepted'};
    if(!unavailableMessage&&Array.isArray(body?.incoming)&&body.incoming.some(invitation=>invitation?.id===id)){
      return {status:'pending',message:'The invitation is still pending. Choose Accept invitation to try again.'};
    }
  }catch{}
  if(unavailableMessage)return {status:'denied',message:unavailableMessage};
  return {status:'unconfirmed',message:'Could not confirm workspace access. Check access again or reload a still-pending invitation.'};
}
