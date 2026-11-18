import {personalConnectionActor} from './portable-connection-session';
import {z} from 'zod';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {CALENDAR_AVAILABILITY_SCOPES,CalendarError,calendarBusy,calendarIdentity,calendarTokens} from '../lib/calendar/google';
import {calendarWindow} from '../lib/calendar/model';
import {portableApiIdentity} from './portable-api-identity';
import {portableCalendarConfig,verifyPortableCalendarConnection} from './portable-calendar-config';
import {requestIdentity} from './portable-identity';
import {portableCalendarSlotHeld,portableOpenCalendarSlots} from '../db/postgres/portable-meeting-store';
import {portableDb} from './portable-db';
import {calendarSuggestionInput,calendarSuggestionWindow,slotsOutsideGoogleBusy} from '../lib/calendar/suggestions';
import {portablePersonalGoogleConfig} from './portable-google-config';
import {boundedGoogleRead,personalGoogleAccess} from './portable-google-connections';
import {ApiError} from '../lib/api-error';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

const connectionCheck=z.object({action:z.literal('check_connection')}).strict();

export async function POST(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const legacy=portableCalendarConfig();
    const config=legacy?.owner===user.email.toLowerCase()?legacy:undefined;
    const personalConfig=config?undefined:portablePersonalGoogleConfig('calendar');
    if(!config&&!personalConfig)return json({error:'Calendar is unavailable for this account.'},403);
    const signedIn=user;
    let input:unknown;
    try{
      const text=await readBoundedRequestText(request,2048);
      if(text!==null)input=JSON.parse(text);
    }catch{}
    const {fetcher:calendarFetch}=boundedGoogleRead();
    let personalConnection:Awaited<ReturnType<typeof personalGoogleAccess>>|undefined;
    async function personalAccess(){
      if(!personalConfig)throw new ApiError(403,'Calendar is unavailable for this account.');
      personalConnection=await personalGoogleAccess(request,await personalConnectionActor(request,signedIn),'calendar',personalConfig,{calendarFetch});
      return personalConnection.accessToken;
    }
    function readBusy(accessToken:string,start:string,end:string){
      const operation=()=>calendarBusy(accessToken,start,end,calendarFetch);
      return personalConnection?personalConnection.read(operation):operation();
    }
    const assertCurrentSession=async()=>{
      const current=await requestIdentity(request.headers);
      if(current?.userId!==user.userId||current.email!==user.email)
        throw new ApiError(403,'Sign in again to check Calendar availability.');
      await personalConnection?.assertCurrent();
    };
    if(connectionCheck.safeParse(input).success){
      await assertCurrentSession();
      if(config)await verifyPortableCalendarConnection(config,calendarFetch,assertCurrentSession);
      else{
        const accessToken=await personalAccess(),now=Date.now();
        await assertCurrentSession();
        await readBusy(accessToken,new Date(now).toISOString(),new Date(now+60_000).toISOString());
      }
      await assertCurrentSession();
      return json({connection:'ok'});
    }
    const parsed=calendarWindow.or(calendarSuggestionInput).safeParse(input),now=Date.now();
    if(!parsed.success){
      return json({error:'Choose a future time window of at most 24 hours within the next year.'},400);
    }
    const window='mode' in parsed.data?calendarSuggestionWindow(parsed.data,now):{...parsed.data,slots:null};
    if(!window.slots&&(Date.parse(window.start)<=now||Date.parse(window.end)>now+366*86_400_000))
      return json({error:'Choose a future time window of at most 24 hours within the next year.'},400);
    await assertCurrentSession();
    let accessToken:string;
    if(config){
      ({accessToken}=await calendarTokens(config,{refreshToken:config.refreshToken},CALENDAR_AVAILABILITY_SCOPES,calendarFetch));
      const calendar=await calendarIdentity(accessToken,calendarFetch);
      if(calendar.email.toLowerCase()!==config.owner)return json({error:'The Calendar connection does not match the signed-in account.'},403);
    }else accessToken=await personalAccess();
    await assertCurrentSession();
    const busy=await readBusy(accessToken,window.start,window.end);
    if(window.slots){
      const slots=await portableOpenCalendarSlots(portableDb(),user.userId,slotsOutsideGoogleBusy(window.slots,busy));
      await assertCurrentSession();
      const checkedAt=new Date();
      return json({slots:slots.filter(slot=>Date.parse(slot.start)>+checkedAt),checkedAt:checkedAt.toISOString()});
    }
    const held=await portableCalendarSlotHeld(portableDb(),user.userId,Date.parse(window.start),Date.parse(window.end));
    await assertCurrentSession();
    return json({availability:held||busy.length?'busy':'free',checkedAt:new Date().toISOString(),...(held?{held:true}:{})});
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof CalendarError&&error.code==='reauth'){
      return json({error:'Ask the operator to reconnect Google Calendar.'},503);
    }
    return json({error:'Calendar availability could not be confirmed. Try again shortly.'},503);
  }
}
