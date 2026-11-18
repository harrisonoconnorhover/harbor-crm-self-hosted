import {z} from 'zod';
import {readContacts} from '../db/postgres/contact-store';
import {portableNeverLogExclusion} from '../db/postgres/portable-never-log-store';
import {finishOutlookLookup} from '../db/postgres/portable-outlook-record-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {outlookDateWindow,outlookLog,outlookLookup} from '../lib/outlook-records';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {requestSessionHash} from './portable-identity';
import {outlookAccess} from './portable-outlook-connections';
import {readOutlookItems} from './portable-outlook-items';

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'private, no-store'}});
async function route(request:Request){
  try{
    const logging=request.method==='PUT';
    const user=await portableApiIdentity(request,logging?'api_write':'api_read');
    if(user instanceof Response)return user;
    if(user.guest||new URL(request.url).search)return json({error:'Open a contact in your own workspace.'},403);
    const sessionHash=await requestSessionHash(request.headers);
    if(!sessionHash)return json({error:'Sign in again to read Outlook.'},401);
    const body=await readBoundedRequestText(request,4000);
    if(body===null)return json({error:'The Outlook request is too large.'},413);
    let raw:unknown;try{raw=JSON.parse(body);}catch{return json({error:'Check the Outlook request.'},400);}
    const parsed=(logging?outlookLog:outlookLookup).safeParse(raw);
    if(!parsed.success)return json({error:'Choose a contact and a search date. Confirm attendance before logging a meeting.'},400);
    const query=parsed.data,range=outlookDateWindow(query,Date.now());
    if(!range)return json({error:'Choose a search window within the last year ending no later than today (UTC).'},400);
    const db=portableDb(),contact=await readContacts(db,user.userId,{id:query.recordId,limit:1});
    if(!contact||!('id' in contact))return json({error:'Contact not found in your private workspace.'},404);
    const address=z.email().max(320).safeParse(contact.data.email);
    if(!address.success)return json({error:'Add a valid email address to this contact before searching.'},400);
    const email=address.data.toLowerCase(),actorEmail=user.email.toLowerCase();
    if(email===actorEmail)return json({error:'Choose a contact with a different address from your Outlook account.'},400);
    if(await portableNeverLogExclusion(db,user.userId,email))return logging?
      json({error:'A Never Log rule excludes this contact.'},409):json({items:[],limited:false});
    const access=await outlookAccess(request,user,query.provider);
    if(access.mailboxEmail!==actorEmail)return json({error:'Reconnect your own Outlook account before searching.'},409);
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(12_000)]);
    const results=await readOutlookItems(query.provider,access.accessToken,email,actorEmail,range,signal,access.assertCurrent);
    await access.assertCurrent();
    if(signal.aborted)throw new ApiError(503,'The Outlook lookup timed out. Try again.');
    return json(await finishOutlookLookup(db,{userId:user.userId,email:actorEmail,sessionHash,grantId:access.grantId,accountId:access.accountId},
      {id:contact.id,createdAt:contact.createdAt,revision:contact.revision,email:address.data},query,results,'selection' in query&&typeof query.selection==='string'?query.selection:undefined));
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    return json({error:'Harbor could not complete this Outlook lookup. Check the timeline before retrying a log.'},503);
  }
}
export {route as POST,route as PUT};
