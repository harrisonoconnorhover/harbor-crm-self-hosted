import {requestSessionHash} from './portable-identity';
import {portableCalendarConfig} from './portable-calendar-config';
import {readSharedTeamBusy} from './portable-team-freebusy';
import {z} from 'zod';
import {emailAddress} from '../lib/email/message';
import {utcDateTime} from '../lib/iso-date-time';
import {readTeamSchedule,changeTeamSchedule,organizerSlotPage,previewCollectiveRoster,replacementHostOptions} from '../db/postgres/team-booking-store';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {teamBookingChange} from '../lib/calendar/team-booking';
import {portableDb} from './portable-db';
import {portableGuestBookingEnabled} from './portable-guest-booking';
import {portableGmailConfig} from './portable-gmail-config';
import {portableLoginConfig} from './portable-login-config';
import {env} from './portable-env';

const query=z.object({team:z.literal('booking'),workspaceId:z.string().guid(),grantId:z.string().guid().optional(),
  useRoster:z.literal('1').optional(),collectiveHosts:z.string().guid().optional(),move:z.string().guid().optional(),replaceHost:z.string().guid().optional(),page:z.string().guid().optional(),after:utcDateTime.optional(),bookingAfter:utcDateTime.optional(),bookingId:z.string().guid().optional(),
  hostSearch:z.string().trim().max(160).optional(),hostAfterEmail:emailAddress.optional(),hostAfterId:z.string().guid().optional(),
  outsideHours:z.literal('1').optional(),formerHosts:z.literal('1').optional(),duringTimeOff:z.enum(['1','team']).optional(),guestEmail:emailAddress.transform(email=>email.toLowerCase()).optional(),
}).strict().refine(({hostAfterEmail,hostAfterId})=>Boolean(hostAfterEmail)===Boolean(hostAfterId))
.refine(({useRoster,move,page,replaceHost,collectiveHosts,after,bookingAfter,bookingId,guestEmail,duringTimeOff,formerHosts,outsideHours,hostAfterId,hostSearch})=>{
  if(useRoster&&!move)return false;
  if([formerHosts,duringTimeOff,outsideHours].filter(Boolean).length>1)return false;
  if(Boolean(bookingAfter)!==Boolean(bookingId)||[move,page,replaceHost,collectiveHosts].filter(Boolean).length>1)return false;
  if(!move&&!page&&!replaceHost&&!collectiveHosts)return !after;
  return !((replaceHost||collectiveHosts)&&after)&&!bookingAfter&&!guestEmail&&!duringTimeOff&&!formerHosts&&!outsideHours&&!hostAfterId&&hostSearch===undefined;
});
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
export async function teamBookingRoute(request:Request,user:{userId:string;email:string;guest:boolean}){
  try{
    const params=query.parse(Object.fromEntries(new URL(request.url).searchParams)),db=portableDb(),w=params.workspaceId;
    if(user.guest&&!await guestWorkspaceAllowed(db,user.userId,w,portableLoginConfig(env).allowedEmails))throw new ApiError(403,'Workspace unavailable.');
    const publicBooking=portableGuestBookingEnabled()&&portableGmailConfig()?.owner===user.email;
    if(request.method==='POST'){
      if(params.collectiveHosts||params.replaceHost||params.move||params.bookingAfter||params.guestEmail||params.duringTimeOff||params.formerHosts||params.outsideHours||params.hostSearch!==undefined||params.hostAfterId)throw new ApiError(400,'Submit changes without booking list filters.');
      if(request.headers.get('origin')!==new URL(request.url).origin)throw new ApiError(403,'Submit bookings from Harbor.');
      const raw=await readBoundedRequestText(request,4096);
      if(!raw)throw new ApiError(400,'Check the scheduling request.');
      const input=teamBookingChange.parse(JSON.parse(raw));
      if(input.action==='create'&&input.publicEnabled&&!publicBooking)throw new ApiError(403,'Guest email verification is unavailable.');
      const sessionHash=await requestSessionHash(request.headers);
      if(!sessionHash)throw new ApiError(403,'Sign in again to manage bookings.');
      await changeTeamSchedule(db,w,{...user,sessionHash},params.grantId??null,input,readSharedTeamBusy);
      return json({saved:true});
    }
    if(params.collectiveHosts)return json(await previewCollectiveRoster(db,w,user.userId,params.grantId??null,params.collectiveHosts,readSharedTeamBusy));
    if(params.replaceHost)return json(await replacementHostOptions(db,w,user.userId,params.grantId??null,params.replaceHost,readSharedTeamBusy));
    if(params.move||params.page){
      return json(await organizerSlotPage(db,w,user.userId,params.grantId??null,params.move?{move:params.move,useRoster:!!params.useRoster}:{page:params.page!},readSharedTeamBusy,params.after));
    }
    const schedule=await readTeamSchedule(db,w,user.userId,params.grantId??null,!!publicBooking,portableCalendarConfig()?.owner,
      params.bookingAfter&&params.bookingId?{start:params.bookingAfter,id:params.bookingId}:undefined,params.guestEmail,{
        query:params.hostSearch??'',after:params.hostAfterEmail&&params.hostAfterId?{email:params.hostAfterEmail,id:params.hostAfterId}:undefined,
      },params.outsideHours?'outsideHours':params.formerHosts?'formerHosts':params.duringTimeOff==='1'?'mine':params.duringTimeOff);
    return json(schedule);
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:'Check the scheduling request.'},400);
    throw error;
  }
}
