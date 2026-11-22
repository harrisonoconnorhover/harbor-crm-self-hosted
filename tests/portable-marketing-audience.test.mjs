import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {tsImport} from 'tsx/esm/api';
import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {applyPortableMigrations,readPortableMigrations} from '../runtime/portable-migrations.mjs';

const {marketingAudiencePage,marketingAudienceStatus,marketingRecipientEligible,syncMarketingAudience,syncConfiguredMarketingAudience}=
  await tsImport('../db/postgres/marketing-audience-store.ts',import.meta.url);
const {salesforceAudienceSourceFromEnv}=await tsImport('../lib/marketing-salesforce.ts',import.meta.url);

const origin='https://fictional-harbor.my.salesforce.com';
const mapping={consentField:'Marketing_Opt_In__c',accountFields:['Industry'],
  related:{object:'Contract__c',accountField:'Account__c',fields:['State__c']}};
const env={HARBOR_SALESFORCE_ORIGIN:origin,HARBOR_SALESFORCE_CLIENT_ID:'fictional-id',HARBOR_SALESFORCE_CLIENT_SECRET:'fictional-secret',
  HARBOR_SALESFORCE_AUDIENCE_MAPPING:JSON.stringify(mapping)};
const id=(prefix,n)=>prefix+String(n).padStart(15,'0');
const email=n=>`person-${String(n).padStart(5,'0')}@example.test`;
const params={contacts:70_000,marketable:31_000,accounts:2_000};
const accountFilter={field:'Industry',value:'Healthcare'},relatedFilter={field:'State__c',value:'Active'};
const combined={account:accountFilter,related:relatedFilter};
const matches=i=>(i%params.accounts)%4===0&&(i%params.accounts)%3===0;
const account=n=>({Id:id('001',n),Industry:n%4===0?'Healthcare':'Services'});
const contract=n=>({Id:id('a00',n),Account__c:id('001',n),State__c:n%3===0?'Active':'Expired'});
const contact=n=>({Id:id('003',n),Email:email(n),AccountId:id('001',n%params.accounts),
  HasOptedOutOfEmail:n>=params.marketable&&n%2===0,Marketing_Opt_In__c:n<params.marketable||n%2===0});

function fixture({pageSize=500,total=params.contacts,tweakPage,onContactRow=contact}={}){
  const calls=[];
  async function fetcher(input,options){
    const url=new URL(input);
    assert.equal(url.origin,origin);
    assert.equal(options.redirect,'error');
    if(url.pathname==='/services/oauth2/token'){
      assert.equal(options.body.get('grant_type'),'client_credentials');
      return Response.json({access_token:'fictional-token',instance_url:origin});
    }
    assert.equal(options.headers.authorization,'Bearer fictional-token');
    const q=url.searchParams.get('q');
    let object,offset;
    if(q){
      object=q.match(/ FROM (\w+) ORDER BY Id$/)?.[1];offset=0;
      if(object==='Contact')assert.match(q,/HasOptedOutOfEmail, Marketing_Opt_In__c/);
    }else{
      const parsed=url.pathname.match(/\/query\/(Account|Contact|Contract__c)-(\d+)$/);
      assert.ok(parsed);object=parsed[1];offset=Number(parsed[2]);
    }
    calls.push({object,offset});
    const size=object==='Contact'?total:Math.min(params.accounts,total);
    const rows=Array.from({length:Math.min(pageSize,size-offset)},(_,n)=>{
      const number=offset+n;
      return object==='Contact'?onContactRow(number):object==='Account'?account(number):contract(number);
    });
    const next=offset+rows.length;
    const page={totalSize:size,done:next===size,records:rows,...(next<size?{nextRecordsUrl:`/services/data/v64.0/query/${object}-${next}`}:{})};
    return Response.json(tweakPage?.(page,object,offset)??page);
  }
  return {calls,source:salesforceAudienceSourceFromEnv(env,fetcher)};
}

test('Salesforce reads complete bounded pages, rejects incomplete counts, and never substitutes an opt-out field for consent',async()=>{
  const limited=fixture({pageSize:1,total:2});
  const pages=await Array.fromAsync(limited.source.pages());
  assert.deepEqual(pages.map(page=>page.kind),['accounts','accounts','related','related','contacts','contacts']);
  assert.equal(pages[4].rows[0].eligible,true);
  assert.equal(limited.calls.length,6);
  assert.throws(()=>salesforceAudienceSourceFromEnv({...env,
    HARBOR_SALESFORCE_AUDIENCE_MAPPING:JSON.stringify({...mapping,consentField:'HasOptedOutOfEmail'})}));
  const truncated=fixture({pageSize:1,total:2,tweakPage:(page,object)=>object==='Contact'?{...page,done:true}:page});
  await assert.rejects(Array.fromAsync(truncated.source.pages()),/incomplete/);
  const badLocator=fixture({pageSize:1,total:2,tweakPage:page=>({...page,nextRecordsUrl:'/different-query'})});
  await assert.rejects(Array.fromAsync(badLocator.source.pages()),/continuation/);
  const traits=fixture({total:4,onContactRow:n=>({...contact(n),Email:n===3?null:'Fictional@EXAMPLE.TEST',
    Marketing_Opt_In__c:[true,'true',null,true][n],HasOptedOutOfEmail:n===0||n===3})});
  const converted=(await Array.fromAsync(traits.source.pages())).find(page=>page.kind==='contacts');
  assert.ok(converted.rows.every(row=>row.eligible===false));
  assert.equal(converted.rows[0].email,'fictional@example.test');
  assert.equal(converted.rows[3].email,null);
});

const sourceDb=process.env.HARBOR_TEST_POSTGRES_URL;
test('70,000 Salesforce contacts: bounded audience pages, related-account segmentation, suppression and safe refresh',
  {skip:!sourceDb,timeout:150000},async t=>{
    const url=new URL(sourceDb);
    assert.ok(url.hostname==='127.0.0.1'&&/^\/harbor_identity_test(?:_[a-z0-9]+)?$/.test(url.pathname),
      'Use the disposable loopback Harbor test database.');
    const admin=postgres(url.href,{max:1,onnotice:()=>{}}),name='harbor_audience_'+crypto.randomUUID().replaceAll('-','');
    let client,created=false;
    try{
      await admin.unsafe('CREATE DATABASE '+name);created=true;url.pathname='/'+name;
      client=postgres(url.href,{max:3,onnotice:()=>{}});
      const db=drizzle(client);
      assert.equal(await applyPortableMigrations(client,readPortableMigrations(resolve('db/postgres/migrations'))),'ok');
      const workspace=crypto.randomUUID(),other=crypto.randomUUID();
      for(const ws of [workspace,other]){
        await client`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
          VALUES(${ws},${ws},${ws+'@example.test'},0,0)`;
        await client`INSERT INTO private_workspaces(id,owner_id) VALUES(${ws},${ws})`;
      }
      const seeded=fixture();
      const start=performance.now();
      const refresh=await syncMarketingAudience(db,workspace,seeded.source);
      const syncMs=Math.round(performance.now()-start);
      assert.equal(refresh.contacts,params.contacts);
      assert.equal(refresh.related,params.accounts);
      assert.equal(refresh.accounts,params.accounts);
      assert.equal(refresh.state,'ready');
      assert.match(refresh.completedAt,/Z$/);
      assert.equal(seeded.calls.length,148);
      const timed=performance.now();
      const first=await marketingAudiencePage(db,workspace,{});
      assert.equal(first.total,params.marketable);assert.equal(first.emails.length,25);
      const subset=await marketingAudiencePage(db,workspace,combined);
      const expected=Array.from({length:params.marketable},(_,i)=>i).filter(matches);
      assert.equal(subset.total,expected.length);
      assert.deepEqual(subset.emails,expected.slice(0,25).map(email));
      const page2=await marketingAudiencePage(db,workspace,combined,subset.next);
      assert.deepEqual(page2.emails,expected.slice(25,50).map(email));
      t.diagnostic(`${refresh.contacts} contacts, ${refresh.accounts} accounts, ${refresh.related} contracts; ${first.total} distinct eligible addresses; ${subset.total} matched both filters. ${seeded.calls.length} simulated Salesforce query pages. Sync ${syncMs} ms; full preview and two filtered previews ${Math.round(performance.now()-timed)} ms.`);
      assert.equal((await marketingAudiencePage(db,other,{})).total,0);
      assert.equal(await marketingRecipientEligible(db,workspace,combined,email(expected[0])),true);
      await assert.rejects(marketingAudiencePage(db,workspace,{account:{field:'industry',value:'Healthcare'}}),/mapped|mapping/);
      await client`INSERT INTO portable_email_suppressions(workspace_id,id,email,created_at)
        VALUES (${workspace},${crypto.randomUUID()},${email(expected[0])},now())`;
      assert.equal(await marketingRecipientEligible(db,workspace,combined,email(expected[0])),false);
      assert.equal((await marketingAudiencePage(db,workspace,combined)).total,expected.length-1);

      // A halted import cannot continue using yesterday's certified contacts.
      let reached,release;
      const started=new Promise(resolve=>{reached=resolve;}),pause=new Promise(resolve=>{release=resolve;});
      const partial={mapping,async *pages(){yield {kind:'accounts',rows:[]};reached();await pause;throw Error('Fictional source interrupted.');}};
      const pending=syncMarketingAudience(db,workspace,partial);
      await started;
      assert.equal((await marketingAudiencePage(db,workspace,{})).status.state,'syncing');
      await assert.rejects(syncMarketingAudience(db,workspace,seeded.source),/already in progress/);
      assert.equal(await marketingRecipientEligible(db,workspace,{},email(7)),false);
      release();await assert.rejects(pending,/interrupted/);
      assert.equal((await marketingAudienceStatus(db,workspace)).state,'failed');
      assert.equal((await marketingAudiencePage(db,workspace,{})).total,0);

      const small=fixture({total:4,onContactRow:n=>({...contact(n),Email:n===1?email(0).toUpperCase():n===3?email(2):email(n),
        Marketing_Opt_In__c:true,HasOptedOutOfEmail:n===1})});
      await syncMarketingAudience(db,workspace,small.source);
      assert.equal(await marketingRecipientEligible(db,workspace,{},email(6)),false);
      // The duplicate veto is checked across *all* contacts sharing the address, including another account.
      await client`DELETE FROM portable_email_suppressions WHERE workspace_id=${workspace}`;
      assert.equal(await marketingRecipientEligible(db,workspace,combined,email(0)),false);
      assert.deepEqual((await marketingAudiencePage(db,workspace,{})).emails,[email(2)]);
      await syncMarketingAudience(db,other,fixture({total:4}).source);
      assert.equal((await marketingAudiencePage(db,other,{})).total,4);
      await assert.rejects(syncConfiguredMarketingAudience(db,other,{...env,HARBOR_SALESFORCE_AUDIENCE_MAPPING:'{}'}));
      assert.equal((await marketingAudiencePage(db,other,{})).status.state,'failed');
      await syncMarketingAudience(db,other,fixture({total:4}).source);
      await assert.rejects(syncConfiguredMarketingAudience(db,other,{...env,HARBOR_SALESFORCE_ORIGIN:'http://invalid.example'}),/My Domain/);
      assert.equal((await marketingAudiencePage(db,other,{})).total,0);
      await client`UPDATE portable_marketing_audience_sync SET started_at=now()-interval '25 hours' WHERE workspace_id=${workspace}`;
      assert.equal((await marketingAudiencePage(db,workspace,{})).status.state,'stale');
      assert.equal(await marketingRecipientEligible(db,workspace,{},email(2)),false);
      const repeated=fixture({total:2,pageSize:1,onContactRow:n=>({...contact(n),Id:id('003',0)})});
      await assert.rejects(syncMarketingAudience(db,workspace,repeated.source),/Could not store/);
      assert.equal((await marketingAudienceStatus(db,workspace)).state,'failed');
    }finally{
      await client?.end({timeout:3});
      try{if(created)await admin.unsafe('DROP DATABASE '+name);}finally{await admin.end({timeout:3});}
    }
  });
