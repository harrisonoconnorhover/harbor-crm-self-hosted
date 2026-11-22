import {readCommerceResult,type RecordAccessActor} from './record-access-store';
import {matchesCommerceSearch,quoteSearchFields} from './commerce-search';
import {and,asc,desc,eq,gt,gte,lt,lte,max,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portableQuoteExportLimit,portableQuoteStatus,type PortableQuoteDetail,type PortableQuoteDisplayStatus,type PortableQuoteFilters,type PortableQuoteMutation,type PortableQuotePage,type PortableQuoteQuery} from '../../lib/portable-quotes';
import {assertQuoteAction,independentLines,quoteData,snapshotQuote,utcToday,validateAcceptance,validatePublication,type Quote} from '../../lib/quotes';
import {ApiError} from '../../lib/api-error';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {activeDeal} from './deal-visibility';
import {deals} from './deal-schema';
import {loginIdentities} from './identity-schema';
import {portableLineItemSets} from './portable-line-item-schema';
import {portableQuoteEvents as events,portableQuotes as quotes,portableQuoteVersions as versions} from './portable-quote-schema';
import {quoteSigningLinks,quoteSignatureReceipts} from './portable-quote-schema';
import {receiptFields} from './quote-signing-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces} from './workspace-schema';

const publicColumns={id:quotes.id,dealId:quotes.dealId,dealName:quotes.dealName,dealCreatedAt:quotes.dealCreatedAt,
  revision:quotes.revision,data:quotes.data,createdAt:quotes.createdAt,updatedAt:quotes.updatedAt,
  number:quotes.number,version:quotes.version,publishedAt:quotes.publishedAt,disposition:quotes.disposition,acceptance:quotes.acceptance};
const size=25;
const tenant=eq(quotes.workspaceId,privateWorkspaces.id);
type QuoteReadOptions=Pick<PortableQuoteQuery,'before'|'version'|'versionBefore'|'download'>;


function matchingQuotes(db:PostgresJsDatabase,actorId:string,input:PortableQuoteFilters&{after?:string},limit:number){
  const title=sql<string>`${quotes.data}->>'title'`,buyer=sql<string>`${quotes.data}->'buyer'->>'name'`;
  const expiresOn=sql<string>`${quotes.data}->>'expiresOn'`;
  const datedExpiresOn=sql<string | null>`nullif(${expiresOn},'')`;
  const today=utcToday();
  // Match quoteStatus for the display only. Mutations use the stored lifecycle state.
  const status=sql<PortableQuoteDisplayStatus>`case
    when ${quotes.disposition} is not null then ${quotes.disposition}
    when ${quotes.publishedAt} is null then 'draft'
    when ${expiresOn}<${today} then 'expired'
    else 'published'
  end`;
  return db.select({id:quotes.id,dealId:quotes.dealId,dealName:quotes.dealName,title,buyer,expiresOn,
    number:quotes.number,version:quotes.version,status:status.as('display_status')})
    .from(quotes).innerJoin(privateWorkspaces,tenant).where(and(eq(privateWorkspaces.ownerId,actorId),
      input.dealId?eq(quotes.dealId,input.dealId):undefined,input.after?gt(quotes.id,input.after):undefined,
      input.status&&input.status!=='all'?sql`${status}=${input.status}`:undefined,
      input.expiresFrom?gte(datedExpiresOn,input.expiresFrom):undefined,
      input.expiresThrough?lte(datedExpiresOn,input.expiresThrough):undefined,
      matchesCommerceSearch(quoteSearchFields(quotes.data,quotes.dealName),input.q)))
    .orderBy(asc(quotes.id)).limit(limit);
}

export async function listPortableQuotes(db:PostgresJsDatabase,actor:RecordAccessActor,includeBody:boolean,input:PortableQuoteQuery):Promise<PortableQuotePage>{
  return readCommerceResult(db,actor,'quotes',includeBody&&'list',async tx=>{
    const rows=await matchingQuotes(tx,actor.userId,input,size+1);
    const items=rows.slice(0,size).map(({id,dealName,title,buyer,expiresOn,number,status,version})=>({id,dealName,title,buyer,expiresOn,number,status,version:version??0}));
    return {items,next:rows.length>size?items.at(-1)!.id:null};
  },result=>result.items.map(item=>item.id));
}

export async function listPortableQuotesForExport(db:PostgresJsDatabase,actorId:string,filters:PortableQuoteFilters){
  const rows=await matchingQuotes(db,actorId,filters,portableQuoteExportLimit+1);
  if(rows.length>portableQuoteExportLimit)return null;
  return rows.map(({id,dealId,dealName,title,expiresOn,number,version,status})=>({id,dealId,dealName,title,expiresOn,number,version,status}));
}

export function readPortableQuote(db:PostgresJsDatabase,actor:RecordAccessActor,includeBody:boolean,id:string,options:QuoteReadOptions={}):Promise<PortableQuoteDetail|null>{
  const {before,version,versionBefore,download}=options;
  return readCommerceResult(db,actor,'quotes',includeBody&&'detail',async tx=>{
    const [row]=await tx.select({...publicColumns,workspaceId:quotes.workspaceId}).from(quotes).innerJoin(privateWorkspaces,tenant)
      .where(and(eq(privateWorkspaces.ownerId,actor.userId),eq(quotes.id,id)));
    if(!row)return null;
    const {workspaceId,disposition,...draft}=row;
    const quote:Quote={...draft,status:portableQuoteStatus(draft.publishedAt,disposition),version:draft.version??0};
    const versionScope=and(eq(versions.workspaceId,workspaceId),eq(versions.quoteId,id));
    const selected=version??(quote.status!=='draft'||download?quote.version:0);
    const versionFields={version:versions.version,publishedAt:versions.publishedAt};
    const [published]=selected?await tx.select({...versionFields,snapshot:versions.snapshot})
      .from(versions).where(and(versionScope,eq(versions.version,selected))):[];
    if(selected&&!published)return null;
    const saved=await tx.select(versionFields).from(versions).where(and(versionScope,
      versionBefore===undefined?undefined:lt(versions.version,versionBefore))).orderBy(desc(versions.version)).limit(size+1);
    const history=await tx.select({revision:events.revision,action:events.action,at:events.at,note:events.note,actorName:loginIdentities.fullName})
      .from(events).innerJoin(loginIdentities,eq(events.actorId,loginIdentities.id)).where(and(eq(events.workspaceId,workspaceId),
        eq(events.quoteId,id),before?lt(events.revision,before):undefined)).orderBy(desc(events.revision)).limit(size+1);
    const [link]=selected?await tx.select({id:quoteSigningLinks.id}).from(quoteSigningLinks).where(and(
      eq(quoteSigningLinks.workspaceId,workspaceId),eq(quoteSigningLinks.quoteId,id),eq(quoteSigningLinks.version,selected))):[];
    const [signature]=selected?await tx.select(receiptFields).from(quoteSignatureReceipts).where(and(
      eq(quoteSignatureReceipts.workspaceId,workspaceId),eq(quoteSignatureReceipts.quoteId,id),eq(quoteSignatureReceipts.version,selected))):[];
    return {quote,signingLinkId:link?.id??null,signature:signature??null,history:history.slice(0,size),next:history.length>size?history[size-1].revision:null,
      versions:saved.slice(0,size),nextVersion:saved.length>size?saved[size-1].version:null,published:published??null};
  },result=>result?[result.quote.id]:[]);
}

export function savePortableQuote(db:PostgresJsDatabase,actor:{userId:string;displayName:string;email:string},input:PortableQuoteMutation){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actor.userId,false,undefined,undefined,true);
    if(!workspaceId)return 'missing';
    const target=and(eq(quotes.workspaceId,workspaceId),eq(quotes.id,input.id));
    const [current]=await tx.select().from(quotes).where(target).for('update');
    const at=new Date().toISOString();
    const note='note' in input?input.note:null;
    let revision=1;
    if(input.action==='create'){
      const creationKey=JSON.stringify(input);
      if(current)return current.creationKey===creationKey?'ok':'stale';
      const [deal]=await tx.select().from(deals).where(and(eq(deals.workspaceId,workspaceId),eq(deals.id,input.dealId),activeDeal)).for('share');
      if(!deal)return 'missing';
      const [lineSet]=await tx.select().from(portableLineItemSets).where(and(eq(portableLineItemSets.workspaceId,workspaceId),
        eq(portableLineItemSets.dealId,deal.id))).for('share');
      if(deal.updatedAt!==input.expectedUpdatedAt||(lineSet?.revision??0)!==input.lineRevision)return 'stale';
      const [contact]=deal.primaryContactId?await tx.select({data:contacts.data}).from(contacts)
        .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,deal.primaryContactId),activeContact)).for('share'):[];
      const [company]=deal.companyId?await tx.select({data:companies.data}).from(companies)
        .where(and(eq(companies.workspaceId,workspaceId),eq(companies.id,deal.companyId),activeCompany)).for('key share'):[];
      const buyer:Record<string,unknown>=contact?.data??company?.data??{};
      const data=quoteData.parse({title:('Quote · '+deal.data.name).slice(0,160),
        seller:{name:actor.displayName.slice(0,160),email:actor.email,address:''},
        buyer:{name:(contact?.data.name??company?.data.name??'').slice(0,160),email:contact?.data.email??'',
          address:[company?.data.name,buyer.address,buyer.city,buyer.state,buyer.postalCode,buyer.country]
            .filter(value=>typeof value==='string'&&value).join('\n').slice(0,2000)},
        expiresOn:new Date(Date.now()+30*86_400_000).toISOString().slice(0,10),comments:'',terms:'',
        items:independentLines(lineSet?.items??[]).map(item=>({...item,id:crypto.randomUUID()}))});
      await tx.insert(quotes).values({workspaceId,id:input.id,dealId:deal.id,dealCreatedAt:deal.createdAt,
        dealName:deal.data.name,revision,creationKey,data,createdAt:at,updatedAt:at});
    }else{
      if(!current)return 'missing';
      if(current.revision!==input.revision||current.revision>=2147483647){
        if(input.action!=='save'&&current.revision===input.revision+1){
          const [receipt]=await tx.select({action:events.action,note:events.note}).from(events).where(and(eq(events.workspaceId,workspaceId),
            eq(events.quoteId,input.id),eq(events.revision,current.revision)));
          const sameAcceptance=input.action!=='accept'||
            current.acceptance?.name===input.name&&current.acceptance.date===input.date;
          if(receipt?.action===input.action&&receipt.note===note&&sameAcceptance)return 'ok';
        }
        return 'stale';
      }
      try{assertQuoteAction({status:portableQuoteStatus(current.publishedAt,current.disposition)},input.action);}
      catch(error){throw new ApiError(409,(error as Error).message);}
      revision=current.revision+1;
      if(input.action==='save'){
        const data={...input.data,items:independentLines(input.data.items)};
        await tx.update(quotes).set({data,revision,updatedAt:at}).where(target);
      }else if(input.action==='recall'){
        await tx.update(quotes).set({revision,updatedAt:at,publishedAt:null,disposition:null}).where(target);
      }else if(input.action==='publish'){
        const data=quoteData.parse(current.data);
        try{validatePublication(data,at.slice(0,10));}
        catch(error){throw new ApiError(400,(error as Error).message);}
        let number=current.number;
        if(number===null){
          const [counter]=await tx.select({last:max(quotes.number)}).from(quotes).where(eq(quotes.workspaceId,workspaceId));
          number=(counter.last??0)+1;
          if(number>2147483647)throw new ApiError(409,'This workspace has reached its quote number limit.');
        }
        const version=(current.version??0)+1;
        await tx.update(quotes).set({revision,updatedAt:at,number,version,publishedAt:at}).where(target);
        await tx.insert(versions).values({workspaceId,quoteId:input.id,version,publishedAt:at,snapshot:snapshotQuote(data)});
      }else if(input.action==='void'){
        await tx.update(quotes).set({revision,updatedAt:at,disposition:'voided'}).where(target);
      }else{
        const [published]=current.version?await tx.select({publishedAt:versions.publishedAt,snapshot:versions.snapshot})
          .from(versions).where(and(eq(versions.workspaceId,workspaceId),eq(versions.quoteId,input.id),eq(versions.version,current.version))):[];
        if(!published)throw new ApiError(409,'Published quote version not found.');
        if(input.action==='accept'){
          try{validateAcceptance(published.publishedAt,published.snapshot.data.expiresOn,input.date,at.slice(0,10));}
          catch(error){throw new ApiError(400,(error as Error).message);}
          await tx.update(quotes).set({revision,updatedAt:at,disposition:'accepted',
            acceptance:{name:input.name,date:input.date,note:input.note}}).where(target);
        }else{
          await tx.update(quotes).set({revision,updatedAt:at,disposition:'declined'}).where(target);
        }
      }
    }
    await tx.insert(events).values({workspaceId,quoteId:input.id,revision,action:input.action,actorId:actor.userId,at,note});
    return 'ok';
  });
}
