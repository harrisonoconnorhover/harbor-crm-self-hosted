import {and,eq,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {z} from 'zod';
import {ApiError} from '../../lib/api-error';
import {randomSecret,sha256} from '../../lib/email/crypto';
import {quoteSigningConsent,type buyerSigningForm,type signingLinkChange} from '../../lib/portable-quote-signing';
import {utcToday} from '../../lib/quotes';
import {activeDeal} from './deal-visibility';
import {deals} from './deal-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {portableQuotes as quotes,portableQuoteVersions as versions,quoteSigningLinks as links,quoteSignatureReceipts as receipts} from './portable-quote-schema';

export const receiptFields={id:receipts.id,signedName:receipts.signedName,signedAt:receipts.signedAt,consent:receipts.consent,digest:receipts.digest};
const missing=()=>new ApiError(404,'This signing link is unavailable. Ask the seller for a current link.');
const stale=()=>new ApiError(409,'The quote or signing link changed. Reload the quote.');
type Db=PostgresJsDatabase;

export function manageQuoteSigningLink(db:Db,userId:string,input:z.output<typeof signingLinkChange>){
  return db.transaction(async tx=>{
    const workspace=await lockRecordWorkspace(tx,userId,false,undefined,undefined,true);
    if(!workspace)throw missing();
    const [quote]=await tx.select().from(quotes).where(and(eq(quotes.workspaceId,workspace),eq(quotes.id,input.id))).for('update');
    if(!quote)throw missing();
    if(quote.revision!==input.revision||quote.version!==input.version)throw stale();
    const scope=and(eq(links.workspaceId,workspace),eq(links.quoteId,input.id),eq(links.version,input.version));
    const [current]=await tx.select({id:links.id}).from(links).where(scope);
    if((current?.id??null)!==input.expectedLink)throw stale();
    if(current)await tx.delete(links).where(scope);
    if(input.action==='revoke-signing-link')return {linkId:null};
    const [deal]=await tx.select({id:deals.id}).from(deals).where(and(eq(deals.workspaceId,workspace),eq(deals.id,quote.dealId),activeDeal)).for('share');
    if(!deal||!quote.publishedAt||quote.disposition||quote.data.expiresOn<utcToday())throw stale();
    const token=randomSecret();
    const [link]=await tx.insert(links).values({workspaceId:workspace,quoteId:input.id,version:input.version,
      tokenHash:await sha256(token),issuerId:userId}).returning({id:links.id});
    return {linkId:link.id,token};
  });
}

export function openSigningQuote(db:Db,input:z.output<typeof buyerSigningForm>){
  return db.transaction(async tx=>{
    const hash=await sha256(input.token);
    const [hint]=await tx.select({workspace:links.workspaceId,id:links.quoteId}).from(links).where(eq(links.tokenHash,hash));
    if(!hint)throw missing();
    const target=and(eq(quotes.workspaceId,hint.workspace),eq(quotes.id,hint.id));
    // Acquire the quote lock first, as recall, offline acceptance and link rotation do.
    const [quote]=await tx.select().from(quotes).where(target).for(input.action==='sign'?'update':'share');
    if(!quote?.publishedAt||!quote.version||quote.number===null)throw missing();
    const {workspaceId,version,id:quoteId}=quote;
    const [edition]=await tx.select({snapshot:versions.snapshot,linkId:links.id,issuerId:links.issuerId,
      digest:sql<string>`encode(sha256(convert_to(${versions.snapshot}::text,'UTF8')),'hex')`})
      .from(links).innerJoin(versions,and(eq(versions.workspaceId,links.workspaceId),eq(versions.quoteId,links.quoteId),eq(versions.version,links.version)))
      .innerJoin(deals,and(eq(deals.workspaceId,workspaceId),eq(deals.id,quote.dealId),activeDeal))
      .where(and(eq(links.workspaceId,workspaceId),eq(links.quoteId,quoteId),eq(links.tokenHash,hash),eq(links.version,version))).for('share');
    if(!edition||edition.snapshot.data.expiresOn<utcToday())throw missing();
    const {linkId,issuerId,digest,snapshot}=edition;
    const [prior]=await tx.select(receiptFields).from(receipts).where(and(eq(receipts.workspaceId,workspaceId),eq(receipts.quoteId,quoteId),eq(receipts.version,version)));
    if(quote.disposition&&!(quote.disposition==='accepted'&&prior))throw missing();
    const document={number:quote.number,version,publishedAt:quote.publishedAt,snapshot,digest};
    if(input.action!=='sign')return {...document,receipt:prior??null};
    if(input.digest!==digest)throw stale();
    if(prior){
      if(prior.signedName!==input.name)throw new ApiError(409,'This version has already been signed.');
      return {...document,receipt:prior};
    }
    const signedAt=new Date().toISOString();
    const [receipt]=await tx.insert(receipts).values({workspaceId,quoteId,version,linkId,issuerId,
      signedName:input.name,signedAt,consent:quoteSigningConsent,digest}).returning(receiptFields);
    await tx.update(quotes).set({disposition:'accepted',revision:quote.revision+1,updatedAt:signedAt,
      acceptance:{name:input.name,date:signedAt.slice(0,10),note:'',method:'electronic'}}).where(target);
    return {...document,receipt};
  });
}
