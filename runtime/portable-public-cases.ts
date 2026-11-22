import {createHash} from 'node:crypto';
import {z} from 'zod';
import {readCaseBrand,readCustomerCases,redeemCaseInvite,signOutCustomerCases} from '../db/postgres/case-portal-store';
import {ticketStatuses} from '../lib/crm';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {escapeEmailText as escape} from '../lib/email/rich-text';
import {helpPageHeaders} from '../lib/help-page-headers';
import {readCookie} from '../lib/identity';
import {portableDb} from './portable-db';
import {helpStyles} from './portable-help-page-styles';
import {portableRateLimit} from './portable-rate-limit';

type Context={params:Promise<{centerId:string}>};
type Brand={name:string;accent:string};
const id=z.string().guid();
const opaque=/^[A-Za-z0-9_-]{43}$/;
const query=z.object({case:id.optional(),after:id.optional(),updates:z.literal('1').optional(),
  q:z.string().trim().max(120).refine(value=>!value.includes('\0')).optional(),
  status:z.union([z.enum(ticketStatuses),z.literal('')]).optional(),
}).strict();
const form=z.discriminatedUnion('action',[
  z.object({action:z.literal('redeem'),invite:z.string().trim().regex(opaque)}).strict(),
  z.object({action:z.literal('signout')}).strict(),
]);
const cookieName='harbor-case-session';
// Preserve Origin on the portal’s own form POSTs while omitting referrers to other sites.
const headers={...helpPageHeaders,'Referrer-Policy':'same-origin','Cache-Control':'private, no-store',Vary:'Cookie'};

// Opening a link, including in a mail scanner, only fills the invitation form.
const invitationScript=`const code=new URLSearchParams(location.hash.slice(1)).get('invite');
if(code && /^[A-Za-z0-9_-]{43}$/.test(code)){
  history.replaceState(null,'',location.pathname+location.search);
  const field=document.querySelector('[name=invite]');
  if(field){
    const details=field.closest('details');
    if(details)details.open=true;
    field.value=code;
    field.form.querySelector('button').focus();
  }
}`;
const scriptHash=createHash('sha256').update(invitationScript).digest('base64');
const styles=helpStyles+`
.case-bar{display:flex;align-items:center;justify-content:space-between;gap:1rem}
.case-bar form{margin:0}.case-bar button{background:white;color:#104d50}
.case-list{list-style:none;padding:0;background:white;border:1px solid #dbe3e1;border-radius:.6rem}
.case-list li{padding:1rem;display:flex;align-items:baseline;justify-content:space-between;gap:1rem}
.case-list li+li{border-top:1px solid #dbe3e1}.case-list a{overflow-wrap:anywhere}
.case-status{font-weight:600;color:#325553}.case-update{white-space:pre-wrap;overflow-wrap:anywhere}
.case-filters{align-items:end}.case-filters>div{display:grid;gap:.2rem;min-width:0}.case-filters label{font-weight:600}
.case-filters select{font:inherit;padding:.65rem;border:1px solid #a3b7b4;border-radius:.4rem;background:white}
.case-invite{display:grid;max-width:27rem}.case-invite input{width:100%;box-sizing:border-box}
.case-invite button{justify-self:start}details{margin:2rem 0}summary{cursor:pointer}
`;

function page(brand:Brand,path:string,title:string,content:string,signedIn=false,status=200){
  const signOut=signedIn?'<form method="post" action="'+path+'"><input type="hidden" name="action" value="signout"><button>Sign out</button></form>':'';
  const accent=/^#[0-9a-f]{6}$/i.test(brand.accent)?brand.accent:'#17696b';
  return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'+
    '<title>'+escape(title)+' · '+escape(brand.name)+'</title><style>:root{--accent:'+accent+'}'+styles+'</style></head><body>'+
    '<header><div class="case-bar"><a href="'+path.slice(0,-6)+'">'+escape(brand.name)+'</a>'+signOut+'</div></header>'+
    '<main>'+content+'</main><script>'+invitationScript+'</script></body></html>',{status,headers:{...headers,
    'Content-Security-Policy':headers['Content-Security-Policy']+"; script-src 'sha256-"+scriptHash+"'"}});
}
function customerStatus(status:string){
  if(status==='Waiting on contact')return 'Waiting on you';
  if(status==='Waiting on us')return 'Waiting on support';
  return escape(status);
}

function invitation(path:string){
  return '<form class="case-invite" action="'+path+'" method="post"><input type="hidden" name="action" value="redeem">'+
    '<label for="case-code">Invitation code</label><input id="case-code" type="password" name="invite" required autocomplete="one-time-code" maxlength="43">'+
    '<button>Open my cases</button></form>';
}
function failure(status:number,message:string){
  return new Response(message,{status,headers:{...headers,'Content-Type':'text/plain; charset=utf-8'}});
}
const unavailable=()=>failure(404,'Case portal unavailable.');
function sessionCookie(path:string,secure:boolean,value:string,maxAge:number){
  return cookieName+'='+value+'; Path='+path+'; HttpOnly; SameSite=Lax; Max-Age='+maxAge+(secure?'; Secure':'');
}

export async function GET(request:Request,{params}:Context){
  const centerId=(await params).centerId;
  const url=new URL(request.url),parsed=query.safeParse(Object.fromEntries(url.searchParams));
  if(!id.safeParse(centerId).success||url.origin!==process.env.HARBOR_LOGIN_ORIGIN||!parsed.success||
    url.searchParams.size!==new Set(url.searchParams.keys()).size)return unavailable();
  const path='/help/'+centerId+'/cases',token=readCookie(request.headers,cookieName),db=portableDb();
  const {case:caseId,after,q,status,updates}=parsed.data;
  const filters=new URLSearchParams();
  if(q)filters.set('q',q);
  if(status)filters.set('status',status);
  if(updates)filters.set('updates','1');
  const listPath=(params:URLSearchParams)=>params.size?path+'?'+escape(params.toString()):path;
  const firstPage=listPath(filters);
  if(after)filters.set('after',after);
  const currentPage=listPath(filters);
  const cases=token?await readCustomerCases(db,centerId,token,caseId?{id:caseId}:{after,q,includeUpdates:!!updates,status:status||undefined}):null;
  if(!cases){
    const brand=await readCaseBrand(db,centerId);
    if(!brand)return unavailable();
    if(caseId)return page(brand,path,'Case unavailable','<h1>Case unavailable</h1><p><a href="'+path+'">Open My cases</a></p>',false,404);
    return page(brand,path,'My cases','<h1>My cases</h1><p>Use the invitation from your support team to see your cases.</p>'+invitation(path));
  }
  const alternate='<details><summary>Use another invitation</summary>'+invitation(path)+'</details>';
  if(caseId){
    const item=cases.items[0];
    if(!item)return page(cases,path,'Case unavailable','<h1>Case unavailable</h1><a href="'+path+'">All cases</a>',true,404);
    return page(cases,path,item.subject,'<a href="'+currentPage+'">'+(filters.size?'Back to case results':'All cases')+'</a><article><h1>'+escape(item.subject)+'</h1>'+
      '<p class="case-status">Status · '+customerStatus(item.status)+'</p>'+(item.update?'<h2>Update</h2><p class="case-update">'+escape(item.update)+'</p>':'')+
      (cases.article?'<h2>Related help article</h2><a href="/help/'+centerId+'/'+cases.article.id+'">'+escape(cases.article.title)+'</a>':'')+'</article>'+alternate,true);
  }
  const list=cases.items.map(item=>{
    const detail=new URLSearchParams([['case',item.id],...filters]);
    return '<li><a href="'+listPath(detail)+'">'+escape(item.subject)+'</a><span class="case-status">'+customerStatus(item.status)+'</span></li>';
  }).join('');
  const form='<form class="case-filters" aria-label="Filter cases" method="get" action="'+path+'">'+
    '<div><label for="case-subject">Search case subjects</label><input id="case-subject" type="search" name="q" maxlength="120" value="'+escape(q??'')+'"></div>'+
    '<div><label for="case-status">Status</label><select id="case-status" name="status"><option value="">All statuses</option>'+ticketStatuses.map(option=>
      '<option value="'+escape(option)+'"'+(option===status?' selected':'')+'>'+customerStatus(option)+'</option>').join('')+'</select></div><label><input type="checkbox" name="updates" value="1"'+(updates?' checked':'')+'> Include published updates</label><button>Apply filters</button>'+
    (q||status||updates?'<a href="'+path+'">Clear filters</a>':'')+'</form>';
  const empty=q||status||updates?'No cases match these filters.':'No cases on this page.';
  if(cases.next)filters.set('after',cases.next);
  return page(cases,path,'My cases','<h1>My cases</h1>'+form+(list?'<ul class="case-list">'+list+'</ul>':'<p>'+empty+'</p>')+
    (cases.next?'<p><a href="'+path+'?'+escape(filters.toString())+'">More cases</a></p>':'')+
    (after?'<p><a href="'+firstPage+'">First page</a></p>':'')+alternate,true);
}

export async function POST(request:Request,{params}:Context){
  const centerId=(await params).centerId,url=new URL(request.url);
  if(!id.safeParse(centerId).success||url.origin!==process.env.HARBOR_LOGIN_ORIGIN||url.search)return unavailable();
  if(request.headers.get('origin')!==url.origin)return failure(403,'Open your invitation in this help center.');
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/x-www-form-urlencoded')return failure(415,'Use the case portal form.');
  const raw=await readBoundedRequestText(request,1024);
  if(raw===null)return failure(413,'Invitation form is too large.');
  const fields=new URLSearchParams(raw),parsed=form.safeParse(Object.fromEntries(fields));
  if(!parsed.success||fields.size!==new Set(fields.keys()).size)return failure(400,'Check the invitation code and try again.');
  const db=portableDb(),path='/help/'+centerId+'/cases',secure=url.protocol==='https:';
  let cookie:string;
  if(parsed.data.action==='signout'){
    const token=readCookie(request.headers,cookieName);
    if(token)await signOutCustomerCases(db,centerId,token);
    cookie=sessionCookie(path,secure,'',0);
  }else{
    const brand=await readCaseBrand(db,centerId);
    if(!brand)return unavailable();
    const limited=await portableRateLimit('public_form','cases:'+centerId);
    if(limited)return limited;
    const result=await redeemCaseInvite(db,centerId,parsed.data.invite);
    if(!result)return page(brand,path,'My cases','<h1>My cases</h1><p role="alert">This invitation is unavailable. Ask your support team for a new invitation.</p>'+invitation(path),false,403);
    cookie=sessionCookie(path,secure,result.token,Math.max(0,Math.floor((result.expiresAt-Date.now())/1000)));
  }
  return new Response(null,{status:303,headers:{...headers,location:path,'set-cookie':cookie}});
}
