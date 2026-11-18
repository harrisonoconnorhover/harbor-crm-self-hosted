import {dismissTaskReminder,readTaskReminders} from '../db/postgres/task-reminder-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {reminderDismissal,reminderQuery} from '../lib/portable-task-reminders';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
async function reminders(request:Request){
  const user=await portableApiIdentity(request);
  if(user instanceof Response)return user;
  const params=new URL(request.url).searchParams;
  const query=reminderQuery.safeParse(Object.fromEntries(params));
  if(!query.success||params.getAll('workspaceId').length>1)return json({error:'Choose a workspace to view reminders.'},400);
  const {workspaceId}=query.data;
  try{
    if(request.method==='GET'||request.method==='HEAD')return json(await readTaskReminders(portableDb(),user.userId,workspaceId));
    let body:unknown;
    try{body=JSON.parse(await readBoundedRequestText(request,768)??'null');}catch{}
    const input=reminderDismissal.safeParse(body);
    if(!input.success)return json({error:'Choose a current reminder to dismiss.'},400);
    const dismissed=await dismissTaskReminder(portableDb(),user.userId,workspaceId,input.data.id,input.data.expectedRevision);
    return dismissed?json({dismissed:true}):json({error:'This reminder changed or is no longer available.'},404);
  }catch{return json({error:'Task reminders are temporarily unavailable.'},503);}
}
export {reminders as GET,reminders as POST};
