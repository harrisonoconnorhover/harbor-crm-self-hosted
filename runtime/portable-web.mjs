import {readFileSync} from 'node:fs';
import handler from '../.harbor/portable-build/server/index.js';
export * from '../.harbor/portable-build/server/index.js';
import {portableFormFrameAncestor,portableHealth,portableIdentitySetupFailure,portableReleaseReady} from '../.harbor/portable-build/worker/health.mjs';

const api=new Set(['/api/crm','/api/logged-activities','/api/background-jobs','/api/record-attachments','/api/workspaces','/api/pipeline','/api/lead-forms','/api/workflows','/api/email/suppressions','/api/calendar/availability-page']);
api.add('/api/associations');
api.add('/api/crm/views');
api.add('/api/crm/search');
api.add('/api/recycle-bin');
api.add('/api/record-merge');
api.add('/api/duplicates');
api.add('/api/leads');
api.add('/api/knowledge-base');
api.add('/api/knowledge-base/categories');
api.add('/api/tickets');
api.add('/api/ticket-sla');
api.add('/api/products');
api.add('/api/quotes');
api.add('/api/invoices');
api.add('/api/deal-line-items');
api.add('/api/task-queues');
api.add('/api/task-reminders');
api.add('/api/reporting');
api.add('/api/custom-properties');
api.add('/api/property-groups');
api.add('/api/segments');
api.add('/api/api-tokens');
api.add('/api/file-folders');
api.add('/api/email/never-log');
const postApi=new Set(['/api/email/unsubscribe','/api/email/inbox','/api/calendar/availability','/api/calendar/meetings',
  '/api/calendar/guest-invitations','/api/crm/import','/api/outlook-records','/api/outlook/availability']);
const personalConnections=new Set(['/api/google/connections','/api/outlook/connections']);
const connectionCallbacks=new Set(['/api/google/gmail/callback','/api/google/calendar/callback','/api/outlook/mail/callback','/api/outlook/calendar/callback']);
const emailTemplates='/api/email/templates';
const formSubmissionPath=/^\/api\/public\/forms\/[0-9a-f-]{36}$/i;
const guestBookingStatus='/api/public/booking-status';
const guestAvailabilityPath=/^\/api\/public\/availability\/[0-9a-f-]{36}$/i;
const externalRecordPath=/^\/api\/v1\/records\/(contacts|companies|deals|tasks|leads|tickets)(?:\/[0-9a-f-]{36})?$/i;
const externalBatchPath=/^\/api\/v1\/records\/(contacts|companies|deals|tasks|leads|tickets)\/batch\/read$/i;
const inquiryWebhookPath=/^\/api\/v1\/forms\/[0-9a-f-]{36}\/inquiries$/i;
const setupPages=new Set(['/auth/sign-in','/privacy','/terms']);
const staticPages=new Set([...setupPages,'/favicon.svg','/harbor.webmanifest','/harbor-icon-180.png','/harbor-icon-192.png','/harbor-icon-512.png','/harbor-starter-contacts.csv','/harbor-starter-contacts-and-companies.csv']);
const pages=new Set([...staticPages,'/','/tickets','/products','/quotes','/auth/sign-out','/email/unsubscribe']);
const loginRoutes=new Set(['/auth/google/start','/auth/google/callback','/auth/microsoft/start','/auth/microsoft/callback']);
const reply=(text,status)=>new Response(text,{status,headers:{'cache-control':'no-store'}});
const fingerprint=readFileSync(new URL('../.harbor/portable-build/release.sha256',import.meta.url),'utf8').trim();
if(!/^[a-f0-9]{64}$/.test(fingerprint))throw Error('The portable build fingerprint is invalid. Rebuild the release.');

function isGuestBooking(pathname){
  return pathname===guestBookingStatus||guestAvailabilityPath.test(pathname);
}

export function portableApiFailureRoute(pathname){
  if(externalRecordPath.test(pathname)||externalBatchPath.test(pathname))return 'records-api';
  if(formSubmissionPath.test(pathname)||inquiryWebhookPath.test(pathname))return 'form-submission';
  if(isGuestBooking(pathname))return 'guest-booking';
  if(api.has(pathname)||postApi.has(pathname)||personalConnections.has(pathname)||connectionCallbacks.has(pathname)||pathname===emailTemplates)
    return pathname;
  return 'other-api';
}

function reportApiFailure(response,route){
  const reference=crypto.randomUUID();
  console.warn(JSON.stringify({event:'harbor_portable_api_failed',reference,route,status:response.status}));
  const headers=new Headers(response.headers);
  headers.set('x-harbor-error-reference',reference);
  headers.set('cache-control','no-store');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

// Run the existing app entry. Allow only routes backed by the portable runtime.
export default async function portableWeb(request,context){
  const {origin,pathname}=new URL(request.url);
  if(pathname==='/healthz'&&['GET','HEAD'].includes(request.method))return portableHealth(request.method,fingerprint);
  if(origin!==process.env.HARBOR_LOGIN_ORIGIN)return reply('Harbor origin does not match this deployment.',421);
  const loginRoute=loginRoutes.has(pathname);
  if(loginRoute&&request.method!=='GET')return new Response(null,{status:405,headers:{allow:'GET','cache-control':'no-store'}});
  const formPage=/^\/forms\/([0-9a-f-]{36})$/i.exec(pathname);
  const availabilityPage=/^\/availability\/[0-9a-f-]{36}$/i.test(pathname);
  const statusPage=pathname==='/booking-status';
  const reading=request.method==='GET'||request.method==='HEAD';
  const supported=(personalConnections.has(pathname)&&['GET','POST','DELETE'].includes(request.method))||
    (connectionCallbacks.has(pathname)&&request.method==='GET')||
    (request.method==='POST'&&(pathname==='/auth/logout'||postApi.has(pathname)||api.has(pathname)||
      formSubmissionPath.test(pathname)||isGuestBooking(pathname)||externalBatchPath.test(pathname)||inquiryWebhookPath.test(pathname)))||
    (request.method==='PUT'&&(pathname==='/api/email/inbox'||pathname==='/api/outlook-records'))||
    (request.method==='DELETE'&&(pathname==='/api/email/suppressions'||pathname==='/api/email/never-log'))||
    (pathname===emailTemplates&&(reading||request.method==='PUT'||request.method==='DELETE'))||
    (reading&&(loginRoute||pages.has(pathname)||api.has(pathname)||formPage||availabilityPage||statusPage||externalRecordPath.test(pathname)));
  if(!supported)return reply('Not found',404);
  const setup=portableIdentitySetupFailure(request);
  if(setup&&pathname==='/'&&reading){
    return new Response(null,{status:307,headers:{location:'/auth/sign-in','cache-control':'no-store'}});
  }
  if(setup&&!staticPages.has(pathname))return setup;
  const setupDocument=setup&&setupPages.has(pathname);
  if(!staticPages.has(pathname)&&!await portableReleaseReady()){
    const headers={'cache-control':'no-store','retry-after':'1'};
    const error='Harbor is waiting for a compatible database. Try again shortly.';
    if(request.method==='HEAD')return new Response(null,{status:503,headers});
    if(pathname.startsWith('/api/'))return reportApiFailure(Response.json({error},{status:503,headers}),'database-readiness');
    return new Response(error,{status:503,headers:{...headers,'content-type':'text/plain; charset=utf-8'}});
  }
  let response=await handler(setupDocument?new Request(origin+pathname,{method:request.method}):request,context);
  if(response.status>=500&&pathname.startsWith('/api/')){
    response=reportApiFailure(response,portableApiFailureRoute(pathname));
  }
  const html=response.headers.get('content-type')?.startsWith('text/html');
  const signIn=pathname==='/auth/sign-in'&&reading;
  if(!html&&!setupDocument&&!signIn&&!availabilityPage&&!statusPage)return response;
  const ancestor=formPage&&response.status===200?await portableFormFrameAncestor(formPage[1]):undefined;
  const headers=new Headers(response.headers);
  if(html)headers.append('content-security-policy','frame-ancestors '+(ancestor??"'none'"));
  if(formPage||availabilityPage||statusPage||setupDocument||signIn)headers.set('cache-control','no-store');
  if(availabilityPage||statusPage)headers.set('referrer-policy','no-referrer');
  if(signIn)headers.set('x-harbor-build-fingerprint',fingerprint);
  if(setupDocument)headers.delete('set-cookie');
  const status=setupDocument&&pathname==='/auth/sign-in'&&response.ok?503:response.status;
  return new Response(response.body,{status,statusText:status===response.status?response.statusText:undefined,headers});
}
