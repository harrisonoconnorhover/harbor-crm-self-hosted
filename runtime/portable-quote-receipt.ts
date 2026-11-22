import {escapeEmailText as esc} from '../lib/email/rich-text';
import {quoteHTML,type Quote,type QuoteSnapshot} from '../lib/quotes';
import type {QuoteSignatureReceipt} from '../lib/portable-quote-signing';

export function signatureReceiptHtml(r:QuoteSignatureReceipt){
  return '<section aria-label="Signature receipt"><h2>Signature receipt</h2><p>Signed by '+esc(r.signedName)+' on '+
    esc(new Date(r.signedAt).toISOString())+' (UTC) using the private signing link.</p><p>'+esc(r.consent)+
    '</p><p>Receipt '+esc(r.id)+'</p><p>Published snapshot SHA-256<br><code style="overflow-wrap:anywhere">'+esc(r.digest)+'</code></p></section>';
}

export function quoteAttachment(quote:Pick<Quote,'number'|'version'|'status'|'acceptance'>,
  published:{snapshot:QuoteSnapshot;publishedAt:string;version:number},signature?:QuoteSignatureReceipt|null){
  const document=quoteHTML(quote,published.snapshot,published.publishedAt,published.version);
  return new Response(signature?document.replace('</body>',()=>signatureReceiptHtml(signature)+'</body>'):document,{headers:{
    'content-type':'text/html; charset=utf-8',
    'content-disposition':`attachment; filename="Harbor-Q-${quote.number}-v${published.version}.html"`,
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    'cache-control':'private, no-store','x-content-type-options':'nosniff',
  }});
}
