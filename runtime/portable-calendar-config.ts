import {CALENDAR_AVAILABILITY_SCOPES,CALENDAR_OWNED_SCOPE,CalendarError,calendarBusy,calendarIdentity,calendarTokens} from '../lib/calendar/google';
import {suppressedAddress} from '../lib/email/suppression';

export function portableCalendarConfig(){
  if(process.env.HARBOR_PORTABLE_CALENDAR_ENABLED!=='true')return undefined;
  const owner=suppressedAddress.safeParse(process.env.HARBOR_PORTABLE_CALENDAR_OWNER);
  const {HARBOR_PORTABLE_CALENDAR_CLIENT_ID:clientId,HARBOR_PORTABLE_CALENDAR_CLIENT_SECRET:clientSecret,
    HARBOR_PORTABLE_CALENDAR_REFRESH_TOKEN:refreshToken}=process.env;
  if(!owner.success||!clientId||!clientSecret||!refreshToken)return undefined;
  return {owner:owner.data,clientId,clientSecret,refreshToken,redirectUri:''};
}

export function portableCalendarInvitesEnabled(){
  return process.env.HARBOR_PORTABLE_CALENDAR_INVITES_ENABLED==='true';
}

export async function verifyPortableCalendarConnection(config:NonNullable<ReturnType<typeof portableCalendarConfig>>,
  fetcher:typeof fetch,assertCurrentSession?:()=>Promise<void>){
  const scopes=portableCalendarInvitesEnabled()?[...CALENDAR_AVAILABILITY_SCOPES,CALENDAR_OWNED_SCOPE]:CALENDAR_AVAILABILITY_SCOPES;
  const {accessToken}=await calendarTokens(config,{refreshToken:config.refreshToken},scopes,fetcher);
  const account=await calendarIdentity(accessToken,fetcher);
  if(account.email.toLowerCase()!==config.owner)throw new CalendarError('reauth','Reconnect Google Calendar to continue.');
  await assertCurrentSession?.();
  const start=Date.now();
  await calendarBusy(accessToken,new Date(start).toISOString(),new Date(start+15*60_000).toISOString(),fetcher);
}

export function portableGuestInvitesEnabled(){
  return process.env.HARBOR_PUBLIC_AVAILABILITY_ENABLED==='true'&&process.env.HARBOR_GUEST_BOOKING_PROOF_ENABLED==='true'&&
    process.env.HARBOR_GUEST_BOOKING_INVITES_ENABLED==='true'&&portableCalendarInvitesEnabled();
}

export function portableCalendarCancellationsEnabled(){
  return process.env.HARBOR_PORTABLE_CALENDAR_CANCELLATIONS_ENABLED==='true';
}

export function portableCalendarReschedulesEnabled(){
  return process.env.HARBOR_PORTABLE_CALENDAR_RESCHEDULES_ENABLED==='true';
}
