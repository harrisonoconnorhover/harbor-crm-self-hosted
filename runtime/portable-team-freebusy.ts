import {CALENDAR_AVAILABILITY_SCOPES,calendarIdentity,calendarTokens,sharedCalendarBusy} from '../lib/calendar/google';
import {portableCalendarConfig} from './portable-calendar-config';
import {boundedGoogleRead} from './portable-google-connections';
import type {ReadTeamBusy} from '../db/postgres/team-booking-store';

// Use the organizer's existing calendar sharing permissions. Hosts opt in for individual windows.
export const readSharedTeamBusy:ReadTeamBusy=async(owner,emails,start,end)=>{
  const config=portableCalendarConfig();
  if(!config||config.owner!==owner.toLowerCase())return new Map();
  const {fetcher:calendarFetch}=boundedGoogleRead();
  try{
    const {accessToken}=await calendarTokens(config,{refreshToken:config.refreshToken},CALENDAR_AVAILABILITY_SCOPES,calendarFetch);
    if((await calendarIdentity(accessToken,calendarFetch)).email.toLowerCase()!==config.owner)return new Map();
    return await sharedCalendarBusy(accessToken,emails,start,end,calendarFetch);
  }catch{
    return new Map();
  }
};
