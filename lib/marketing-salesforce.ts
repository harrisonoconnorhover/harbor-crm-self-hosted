import {readBoundedRequestText} from './bounded-request-text';
import {suppressedAddress} from './email/suppression';
import {salesforceAudienceMapping,type MarketingFields,type SalesforceAudienceMapping,type SalesforceAudienceSource} from './marketing-audience';

type Env=Record<string,string|undefined>;
type SalesforceApi={origin:string;apiPath:string;accessToken:string};
type Row=Record<string,unknown>;

async function objectResponse(response:Response,limit:number,operation:string):Promise<Row>{
  if(!response.ok)throw new Error(`Salesforce ${operation} returned HTTP ${response.status}.`);
  const result=await readBoundedRequestText(response,limit);
  if(!result)throw new Error(`Salesforce ${operation} returned an empty or oversized response.`);
  let value:unknown;
  try{value=JSON.parse(result);}catch{throw new Error(`Invalid JSON in Salesforce ${operation} response.`);}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`Invalid Salesforce ${operation} response.`);
  return value as Row;
}

function salesforceOrigin(env:Env){
  const raw=env.HARBOR_SALESFORCE_ORIGIN;
  if(!raw)throw new Error('Set HARBOR_SALESFORCE_ORIGIN to the Salesforce My Domain HTTPS origin.');
  const url=new URL(raw);
  if(url.protocol!=='https:'||!url.hostname.endsWith('.my.salesforce.com')||url.port||url.username||url.password||
    url.pathname!=='/'||url.search||url.hash)throw new Error('Use the exact Salesforce My Domain HTTPS origin.');
  return url.origin;
}

export async function salesforceApiFromEnv(env:Env,fetchImpl:typeof fetch=fetch):Promise<SalesforceApi>{
  const origin=salesforceOrigin(env);
  const version=env.HARBOR_SALESFORCE_API_VERSION??'v64.0';
  if(!/^v\d{2,3}\.0$/.test(version))throw new Error('Use a version such as v64.0 for the Salesforce API.');
  const id=env.HARBOR_SALESFORCE_CLIENT_ID,secret=env.HARBOR_SALESFORCE_CLIENT_SECRET;
  if(!id||!secret)throw new Error('Set the server-side Salesforce integration client ID and secret.');
  const result=await objectResponse(await fetchImpl(origin+'/services/oauth2/token',{method:'POST',redirect:'error',
    signal:AbortSignal.timeout(20_000),body:new URLSearchParams({grant_type:'client_credentials',client_id:id,client_secret:secret})}),
    32*1024,'authentication');
  if(typeof result.access_token!=='string'||!result.access_token||result.access_token.length>8_192||
    typeof result.instance_url!=='string'||result.instance_url.replace(/\/$/,'')!==origin){
    throw new Error('The Salesforce token response did not match the configured organization.');
  }
  return {origin,apiPath:'/services/data/'+version,accessToken:result.access_token};
}

async function* queryPages(api:SalesforceApi,object:string,fields:string[],fetchImpl:typeof fetch){
  const selected=[...new Set(fields)];
  const queryRoot=api.apiPath+'/query';
  const soql=`SELECT ${selected.join(', ')} FROM ${object} ORDER BY Id`;
  let path=queryRoot+'?'+new URLSearchParams({q:soql}),total:number|undefined,received=0;
  for(;;){
    const page=await objectResponse(await fetchImpl(api.origin+path,{
      headers:{authorization:'Bearer '+api.accessToken,accept:'application/json','sforce-query-options':'batchSize=500'},
      redirect:'error',signal:AbortSignal.timeout(30_000),
    }),8*1024*1024,'audience query');
    if(!Array.isArray(page.records)||page.records.length>2_000||typeof page.done!=='boolean'||
      !Number.isSafeInteger(page.totalSize)||Number(page.totalSize)<0||
      (total!==undefined&&page.totalSize!==total))throw new Error('Invalid Salesforce results page.');
    total=Number(page.totalSize);
    const rows:Row[]=page.records.map(value=>{
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid Salesforce row.');
      for(const field of selected){
        if(!Object.hasOwn(value,field))throw new Error(`Salesforce did not return configured field ${object}.${field}.`);
      }
      return value;
    });
    received+=rows.length;
    if(received>total||(page.done&&received!==total)||(!page.done&&(!rows.length||received>=total))){
      throw new Error('Salesforce returned an incomplete or inconsistent result count.');
    }
    yield rows;
    if(page.done)return;
    const next=page.nextRecordsUrl;
    // A continuation is a locator under this API version; never forward the bearer token to a returned host.
    if(typeof next!=='string'||!next.startsWith(queryRoot+'/')||
      !/^[A-Za-z0-9_-]{1,256}$/.test(next.slice(queryRoot.length+1))||next===path){
      throw new Error('Invalid Salesforce query continuation.');
    }
    path=next;
  }
}

function salesforceId(value:unknown,nullable:false):string;
function salesforceId(value:unknown,nullable:true):string|null;
function salesforceId(value:unknown,nullable:boolean){
  if(nullable&&value===null)return null;
  if(typeof value!=='string'||!/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value))throw new Error('Invalid Salesforce record ID.');
  return value;
}

function selectedValues(row:Row,keys:string[]):MarketingFields{
  const entries=keys.map(key=>{
    const value=row[key];
    if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||
      typeof value==='string'&&value.length<=4096)return [key,value] as const;
    throw new Error(`Choose a scalar Salesforce field of up to 4,096 characters for ${key}.`);
  });
  return Object.fromEntries(entries);
}

export function salesforceAudienceSourceFromEnv(env:Env,fetchImpl:typeof fetch=fetch):SalesforceAudienceSource{
  if(!env.HARBOR_SALESFORCE_AUDIENCE_MAPPING)throw new Error('Set HARBOR_SALESFORCE_AUDIENCE_MAPPING.');
  const mapping:SalesforceAudienceMapping=salesforceAudienceMapping.parse(JSON.parse(env.HARBOR_SALESFORCE_AUDIENCE_MAPPING));
  return {mapping,origin:salesforceOrigin(env),async *pages(){
    const api=await salesforceApiFromEnv(env,fetchImpl);
    for await(const rows of queryPages(api,'Account',['Id',...mapping.accountFields],fetchImpl)){
      yield {kind:'accounts',rows:rows.map(row=>({id:salesforceId(row.Id,false),fields:selectedValues(row,mapping.accountFields)}))};
    }
    const related=mapping.related;
    if(related){
      for await(const rows of queryPages(api,related.object,['Id',related.accountField,...related.fields],fetchImpl)){
        yield {kind:'related',rows:rows.map(row=>({id:salesforceId(row.Id,false),
          accountId:salesforceId(row[related.accountField],true),fields:selectedValues(row,related.fields)}))};
      }
    }
    for await(const rows of queryPages(api,'Contact',['Id','Email','AccountId','HasOptedOutOfEmail',mapping.consentField],fetchImpl)){
      yield {kind:'contacts',rows:rows.map(row=>{
        const normalized=suppressedAddress.safeParse(row.Email);
        return {id:salesforceId(row.Id,false),accountId:salesforceId(row.AccountId,true),
          email:normalized.success?normalized.data:null,eligible:row[mapping.consentField]===true&&row.HasOptedOutOfEmail===false};
      })};
    }
  }};
}
