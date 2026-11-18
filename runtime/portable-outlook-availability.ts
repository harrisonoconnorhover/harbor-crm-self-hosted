import {z} from 'zod';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableApiIdentity} from './portable-api-identity';
import {outlookAccess} from './portable-outlook-connections';

const window=z.object({start:z.iso.datetime(),end:z.iso.datetime()}).strict();
const page=z.object({value:z.array(z.object({isCancelled:z.boolean(),showAs:z.string()})).max(100),
  '@odata.nextLink':z.string().optional()});
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

export async function POST(request:Request) {
  try {
    const user=await portableApiIdentity(request);
    if (user instanceof Response) return user;
    let body:unknown;
    try { body=JSON.parse(await readBoundedRequestText(request,2048) || 'null'); } catch { /* Invalid body. */ }
    const parsed=window.safeParse(body);
    if (!parsed.success) return json({error:'Choose a valid time window.'},400);
    const {start,end}=parsed.data;
    const duration=Date.parse(end)-Date.parse(start);
    if (duration<=0 || duration>120*60_000) return json({error:'Choose a window of up to two hours.'},400);
    const grant=await outlookAccess(request,user,'outlook-calendar');
    const url=new URL('https://graph.microsoft.com/v1.0/me/calendarView');
    url.search=new URLSearchParams({startDateTime:start,endDateTime:end,'$select':'isCancelled,showAs','$top':'100'}).toString();
    const result=await fetch(url,{headers:{authorization:'Bearer '+grant.accessToken},redirect:'error',cache:'no-store',
      signal:AbortSignal.timeout(12_000)});
    if (!result.ok) throw new ApiError(result.status===401||result.status===403?409:503,
      result.status===401||result.status===403?'Check your Outlook Calendar connection in settings.':'Outlook could not check this time.');
    const events=page.parse(JSON.parse(await readBoundedRequestText(result,32768) || 'null'));
    const active=events.value.filter(event=>!event.isCancelled);
    const busy=active.some(event=>['tentative','busy','oof','workingElsewhere'].includes(event.showAs));
    const unknown=Boolean(events['@odata.nextLink']) || active.some(event=>event.showAs!=='free');
    await grant.assertCurrent();
    return json({availability:busy?'busy':unknown?'unknown':'free',checkedAt:new Date().toISOString()});
  } catch (error) {
    return error instanceof ApiError?json({error:error.message},error.status):json({error:'Outlook could not confirm availability.'},503);
  }
}
