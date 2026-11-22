import {z} from 'zod';
import {ownerCaseState,changeCasePortal} from '../db/postgres/case-portal-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {casePortalChange} from '../lib/portable-case-portal';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {requestSessionHash} from './portable-identity';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store','referrer-policy':'no-referrer'}});

async function casePortal(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const url=new URL(request.url);
    if(user.guest||url.searchParams.has('workspaceId'))return json({error:'Manage customer access from your own workspace.'},403);
    if(request.method==='GET'||request.method==='HEAD'){
      const ticket=z.string().guid().safeParse(url.searchParams.get('ticketId'));
      if(!ticket.success||url.searchParams.size!==1)return json({error:'Choose a ticket.'},400);
      return json(await ownerCaseState(portableDb(),user,ticket.data,request.method!=='HEAD'));
    }
    if(url.searchParams.size)return json({error:'Send customer access changes without query parameters.'},400);
    if(request.headers.get('origin')!==url.origin)return json({error:'Open the ticket in Harbor to manage customer access.'},403);
    const sessionHash=await requestSessionHash(request.headers);
    if(!sessionHash)return json({error:'Sign in again to manage customer access.'},403);
    const body=await readBoundedRequestText(request,32_768);
    if(body===null)return json({error:'The customer update is too long.'},413);
    const parsed=casePortalChange.safeParse(JSON.parse(body));
    if(!parsed.success)return json({error:'Check the contact, ticket and customer-facing case details.'},400);
    return json(await changeCasePortal(portableDb(),{...user,sessionHash},parsed.data));
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof SyntaxError)return json({error:'Send valid customer access settings.'},400);
    console.error('Portable customer case management failed.');
    return json({error:'Could not confirm the change. Reload the ticket to check customer access.'},503);
  }
}

export {casePortal as GET,casePortal as HEAD,casePortal as POST};
