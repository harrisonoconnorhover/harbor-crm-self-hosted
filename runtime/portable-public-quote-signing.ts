import {createHash} from 'node:crypto';
import {openSigningQuote} from '../db/postgres/quote-signing-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {escapeEmailText as esc} from '../lib/email/rich-text';
import {helpPageHeaders} from '../lib/help-page-headers';
import {buyerSigningForm,quoteSigningConsent} from '../lib/portable-quote-signing';
import {quoteHTML} from '../lib/quotes';
import {portableDb} from './portable-db';
import {quoteAttachment,signatureReceiptHtml} from './portable-quote-receipt';
import {portableRateLimit} from './portable-rate-limit';

// Opening another private link in the same tab can change only the fragment of a POST result.
const fillLink=`function openLink(){
  const token=location.hash.slice(1);
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))return;
  const review=document.querySelector('input[name="action"][value="review"]');
  if(!review){location.replace('/quote-sign?open#'+token);return;}
  history.replaceState(null,'',location.pathname);
  review.form.elements.token.value=token;
  review.form.querySelector('button').focus();
}
addEventListener('hashchange',openLink);
openLink();`;
const scriptHash=createHash('sha256').update(fillLink).digest('base64');
const headers={...helpPageHeaders,'Cache-Control':'private, no-store','Referrer-Policy':'same-origin',
  'Content-Security-Policy':helpPageHeaders['Content-Security-Policy']+"; script-src 'sha256-"+scriptHash+"'"};
const style="body{font:1rem/1.55 system-ui;color:#20383d;max-width:48rem;margin:8vh auto;padding:0 1.5rem}form{display:grid;gap:1rem}button{justify-self:start;padding:.65rem 1rem;border-radius:6px;background:#08676b;color:white;border:0;cursor:pointer}input{font:inherit}";
function message(title:string,body:string,status=200){
  return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+
    esc(title)+' · Harbor</title><style>'+style+'</style></head><body><main><h1>'+esc(title)+'</h1>'+body+'</main></body></html>',{status,headers});
}

export function GET(){
  return message('Review your quote','<form method="post" action="/quote-sign"><input type="hidden" name="action" value="review"><input type="hidden" name="token">'+
    '<p>Open the seller’s private link to review the published terms and pricing.</p><button>Review quote</button></form><script>'+fillLink+'</script>');
}

export async function POST(request:Request){
  const url=new URL(request.url);
  if(url.origin!==process.env.HARBOR_LOGIN_ORIGIN||request.headers.get('origin')!==url.origin||url.search)
    return message('Open the seller’s signing link','',403);
  if(request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')return message('Use the signing form','',415);
  try{
    const body=await readBoundedRequestText(request,4096);
    if(body===null)return message('Signing form too large','',413);
    const params=new URLSearchParams(body),parsed=buyerSigningForm.safeParse(Object.fromEntries(params));
    if(!parsed.success||params.size!==new Set(params.keys()).size)return message('Check the signing form','<p>Review the quote, enter your name and confirm the terms before signing.</p>',400);
    const input=parsed.data;
    const bucket=createHash('sha256').update(input.token).digest('hex').slice(0,2);
    const limited=await portableRateLimit('public_form','quote-sign:'+bucket);
    if(limited)return limited;
    const {number,version,publishedAt,snapshot,digest,receipt}=await openSigningQuote(portableDb(),input);
    const quote={number,version,status:receipt?'accepted' as const:'published' as const,acceptance:receipt?
      {method:'electronic' as const,name:receipt.signedName,date:new Date(receipt.signedAt).toISOString().slice(0,10),note:''}:null};
    if(input.action==='download'){
      if(!receipt)return message('Sign the quote before downloading a signed copy','',409);
      return quoteAttachment(quote,{snapshot,publishedAt,version},receipt);
    }
    const content=receipt?signatureReceiptHtml(receipt)+'<form action="/quote-sign" method="post">'+
      '<input type="hidden" name="action" value="download"><input type="hidden" name="token" value="'+esc(input.token)+'">'+
      '<button>Download signed quote</button></form>':'<section><h2>Sign this quote</h2><form action="/quote-sign" method="post">'+
      '<input type="hidden" name="action" value="sign"><input type="hidden" name="token" value="'+esc(input.token)+'"><input type="hidden" name="digest" value="'+digest+'">'+
      '<label>Full name <input name="name" required maxlength="160" autocomplete="name"></label><label><input type="checkbox" name="consent" value="yes" required> '+
      esc(quoteSigningConsent)+'</label><button>Sign quote</button></form></section>';
    const document=quoteHTML(quote,snapshot,publishedAt,version,receipt?'Signed quote. Retain a copy for your records.':'Review the pricing and terms before signing below.');
    return new Response(document.replace('</style>',()=>style+'table{display:block;overflow-x:auto}.parties{flex-wrap:wrap;gap:1.25rem}.parties section{min-width:min(14rem,100%)}.multiline,p,code{overflow-wrap:anywhere}@media print{form{display:none}table{display:table}}</style>').replace('</body>',()=>content+'<script>'+fillLink+'</script></body>'),{headers});
  }catch(error){
    if(error instanceof ApiError)return message(error.message,'',error.status);
    return message('Could not confirm the quote','<p>Open the original link again to check its status.</p>',503);
  }
}
