import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import 'tsx/esm';
import {sendMarketingEmail} from '../lib/marketing-mail-transport.mjs';
import {applyPortableMigrations,readPortableMigrations} from '../runtime/portable-migrations.mjs';

const domain=await import('../lib/marketing-form-delivery.ts');
const {configureMarketingForm,runMarketingFormPass,listMarketingFormDeliveries,resolveMarketingFormDelivery}
  =await import('../db/postgres/marketing-form-store.ts');
const {manageLeadForm,submitLeadInquiry}=await import('../db/postgres/lead-form-store.ts');
const {runMarketingCampaignPass}=await import('../db/postgres/marketing-campaign-store.ts');
const workspaceId=randomUUID(),otherWorkspace=randomUUID();
const env={HARBOR_MARKETING_WORKSPACE_ID:workspaceId,HARBOR_MARKETING_DELIVERY_ENABLED:'true',
  HARBOR_MARKETING_FORM_RECIPIENTS:'sales@example.test,support@example.test',HARBOR_SALESFORCE_ORIGIN:'https://fictional.my.salesforce.com',
  HARBOR_SALESFORCE_FORM_MAPPING:JSON.stringify({object:'Website_Inquiry__c',externalIdField:'Harbor_Id__c',
    fields:{name:'Name',email:'Email__c',message:'Message__c',phone:'Phone__c'},constants:{Source__c:'Website'}})};
const payload={name:'Riley Example',email:'riley@example.test',phone:'',message:'Training & support <please>'};
const connect=async()=>({origin:env.HARBOR_SALESFORCE_ORIGIN,apiPath:'/services/data/v64.0',accessToken:'fictional-token'});

test('configured recipients stay internal and Salesforce uses the mapped, stable external ID',async()=>{
  const inquiryId=randomUUID(),input={workspaceId,inquiryId,payload:{...payload,country:'Canada'},reconcile:false};
  assert.throws(()=>domain.parseMarketingFormRoute({recipients:[payload.email],salesforce:false},env),/Choose an address/);
  assert.throws(()=>domain.assertFormMarketingWorkspace(otherWorkspace,env),/workspace/i);
  assert.throws(()=>domain.salesforceFormTarget({...env,HARBOR_SALESFORCE_FORM_MAPPING:JSON.stringify({object:'Bad',externalIdField:'Id',fields:{name:'Name',email:'Email'}})}));
  const route=domain.parseMarketingFormRoute({recipients:['SALES@example.test','sales@example.test'],salesforce:true},env);
  assert.deepEqual(route.recipients,['sales@example.test']);
  const reordered=JSON.parse(env.HARBOR_SALESFORCE_FORM_MAPPING);
  reordered.fields=Object.fromEntries(Object.entries(reordered.fields).reverse());
  assert.equal(route.salesforceTarget,domain.salesforceFormTarget({...env,HARBOR_SALESFORCE_FORM_MAPPING:JSON.stringify(reordered)}).destination);
  const notice=domain.formNotificationMessage(route.recipients[0],inquiryId,'Sales',payload);
  assert.equal(notice.to,'sales@example.test');assert.match(notice.html,/&lt;please&gt;/);assert.doesNotMatch(notice.subject,/Riley/);
  const key=workspaceId+'-'+inquiryId,received=[];
  const adapter=async(url,init)=>{
    assert.equal(url.origin,env.HARBOR_SALESFORCE_ORIGIN);assert.ok(url.pathname.endsWith('/Website_Inquiry__c/Harbor_Id__c/'+key));
    assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer fictional-token');
    received.push(init.method??'GET');
    if(init.method==='PATCH'){
      assert.deepEqual(JSON.parse(init.body),{Source__c:'Website',Name:payload.name,Email__c:payload.email,Message__c:payload.message});
      return Response.json({id:'a00123456789012',success:true},{status:201});
    }
    assert.equal(url.searchParams.get('fields'),'Id');return Response.json({Id:'a00123456789012'});
  };
  assert.equal((await domain.deliverSalesforceInquiry(input,env,connect,adapter)).id,'a00123456789012');
  assert.equal((await domain.deliverSalesforceInquiry({...input,reconcile:true},env,connect,adapter)).id,'a00123456789012');
  assert.deepEqual(received,['PATCH','GET']);
  reordered.fields.country='Country__c';
  const withCountry={...env,HARBOR_SALESFORCE_FORM_MAPPING:JSON.stringify(reordered)};
  assert.notEqual(domain.salesforceFormTarget(withCountry).destination,route.salesforceTarget);
  await domain.deliverSalesforceInquiry(input,withCountry,connect,async(_url,init)=>{
    assert.equal(JSON.parse(init.body).Country__c,'Canada');
    return Response.json({id:'a00123456789012',success:true},{status:201});
  });
  await assert.rejects(domain.deliverSalesforceInquiry(input,env,connect,async()=>{throw Error('lost');}),e=>e.disposition==='uncertain');
  await assert.rejects(domain.deliverSalesforceInquiry(input,env,connect,async()=>new Response(null,{status:429})),e=>e.disposition==='retry');
  await assert.rejects(domain.deliverSalesforceInquiry(input,env,connect,async()=>Response.json([{errorCode:'REQUEST_LIMIT_EXCEEDED'}],{status:403})),e=>e.disposition==='retry');
  await assert.rejects(domain.deliverSalesforceInquiry(input,env,connect,async()=>new Response(null,{status:408})),e=>e.disposition==='uncertain');
  await assert.rejects(domain.deliverSalesforceInquiry(input,env,connect,async()=>Response.json({})),e=>e.disposition==='uncertain');
  await assert.rejects(domain.deliverSalesforceInquiry({...input,reconcile:true},env,connect,async()=>new Response(null,{status:300})),e=>e.disposition==='rejected');
});

const database=process.env.HARBOR_TEST_POSTGRES_URL;
test('actual portable form admission, leased dispatch and human reconciliation in PostgreSQL',
  {skip:!database,timeout:90000},async()=>{
    const uri=new URL(database);
    assert.equal(uri.hostname,'127.0.0.1');assert.match(uri.pathname,/^\/harbor_identity_test(?:_[a-z0-9]+)?$/);
    const admin=postgres(uri.href,{max:1,onnotice:()=>{}}),name='harbor_form_test_'+randomUUID().replaceAll('-','');
    const priorBinding=process.env.HARBOR_MARKETING_WORKSPACE_ID;
    let client;
    try{
      process.env.HARBOR_MARKETING_WORKSPACE_ID=workspaceId;
      await admin`CREATE DATABASE ${admin(name)}`;uri.pathname='/'+name;
      client=postgres(uri.href,{max:5,onnotice:()=>{}});const db=drizzle(client);
      const folder=fileURLToPath(new URL('../db/postgres/migrations',import.meta.url));
      assert.equal(await applyPortableMigrations(client,readPortableMigrations(folder)),'ok');
      const a='form-owner-a',b='form-owner-b';
      for(const [id,workspace] of [[a,workspaceId],[b,otherWorkspace]]){
        await client`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at) VALUES (${id},${id},${id+'@example.test'},1,1)`;
        await client`INSERT INTO private_workspaces(id,owner_id) VALUES (${workspace},${id})`;
      }
      async function form(owner,title,host){
        const id=randomUUID();
        await manageLeadForm(db,owner,{action:'save',id,revision:0,definition:{title,description:'',thankYou:'Thanks',
          embedOrigin:host,captureContacts:false,queueWorkflows:false}});
        await manageLeadForm(db,owner,{action:'setEnabled',id,revision:1,enabled:true});
        return id;
      }
      const sales=await form(a,'Sales','https://fictional-webflow.example.test'),support=await form(a,'Support','https://fictional-wordpress.example.test');
      const outside=await form(b,'Outside','https://elsewhere.example.test');
      const submit=(formId,id=randomUUID())=>submitLeadInquiry(db,formId,workspaceId,{id,revision:2,website:'',payload},'fingerprint-'+id);
      await submit(sales); // Configuring routing must not forward previously collected inquiries.
      await assert.rejects(configureMarketingForm(db,workspaceId,outside,{recipients:['sales@example.test'],salesforce:false},env),/this workspace/);
      await configureMarketingForm(db,workspaceId,sales,{recipients:['sales@example.test'],salesforce:true},env);
      await configureMarketingForm(db,workspaceId,support,{recipients:['support@example.test'],salesforce:false},env);
      delete process.env.HARBOR_MARKETING_WORKSPACE_ID;
      await submit(sales);
      process.env.HARBOR_MARKETING_WORKSPACE_ID=otherWorkspace;
      await submit(support);
      process.env.HARBOR_MARKETING_WORKSPACE_ID=workspaceId;
      const id=randomUUID();await Promise.all([submit(sales,id),submit(sales,id)]);await submit(support);
      const deliveries=()=>listMarketingFormDeliveries(db,workspaceId,100,env);
      assert.equal((await deliveries()).length,3);
      assert.equal((await runMarketingFormPass(db,workspaceId,{...env,HARBOR_MARKETING_DELIVERY_ENABLED:'false'})).status,'disabled');
      const email=[],sf=[];
      const success={notify:async body=>{email.push(body);return {id:'mail-'+body.to};},
        upsert:async obj=>{sf.push(obj);return {id:'a00123456789012'};}};
      const pass=(providers=success)=>runMarketingFormPass(db,workspaceId,env,providers);
      await Promise.all([pass(),pass(),pass(),pass()]);
      assert.deepEqual(email.map(p=>p.to).sort(),['sales@example.test','support@example.test']);assert.deepEqual(sf.map(i=>i.inquiryId),[id]);
      assert.equal((await deliveries()).filter(j=>j.state==='succeeded').length,3);
      assert.equal((await pass()).status,'idle');
      await submit(support);
      const unknown=await pass({...success,notify:async()=>{throw Error('private provider detail');}});
      assert.equal(unknown.status,'uncertain');assert.equal((await pass()).status,'idle');
      assert.doesNotMatch((await deliveries()).find(row=>row.id===unknown.id).issue,/private provider/);
      await assert.rejects(resolveMarketingFormDelivery(db,workspaceId,unknown.id,'retry',undefined,env),/reference/);
      await resolveMarketingFormDelivery(db,workspaceId,unknown.id,'confirmed','operator-mail-accepted',env);
      assert.equal((await pass()).status,'idle');

      const delayed=randomUUID();await submit(support,delayed);
      const mailEnv={...env,HARBOR_MARKETING_FROM:'sender@example.test',HARBOR_RESEND_API_KEY:'fictional',
        HARBOR_LOGIN_ORIGIN:'https://mail.example.test',HARBOR_MARKETING_POSTAL_ADDRESS:'Fictional address',HARBOR_RESEND_WEBHOOK_SECRET:'whsec_fixture'};
      const rate=await pass({...success,notify:message=>sendMarketingEmail(message,mailEnv,async()=>
        new Response(null,{status:429,headers:{'retry-after':'180'}}))});
      assert.equal(rate.status,'pending');assert.equal((await pass()).status,'throttled');
      assert.ok((await deliveries()).find(job=>job.id===rate.id).nextAt>Date.now()+175000);
      // A separate workspace and job type still share this instance's sender.
      assert.equal(await runMarketingCampaignPass(db,otherWorkspace,mailEnv,()=>assert.fail()),'throttled');
      const duringPause=randomUUID();await submit(sales,duringPause);
      assert.equal((await pass()).status,'succeeded','Salesforce remains independent of an email cooldown.');
      assert.equal(sf.at(-1).inquiryId,duringPause);
      assert.equal((await pass()).status,'throttled');
      const [untouched]=await client`SELECT attempts,state FROM portable_marketing_form_deliveries
        WHERE inquiry_id=${duringPause} AND kind='email'`;
      assert.deepEqual({...untouched},{attempts:0,state:'pending'});
      await client`UPDATE portable_marketing_form_deliveries SET next_at=0 WHERE workspace_id=${workspaceId} AND id=${rate.id}`;
      await client`UPDATE portable_marketing_mail_cooldown SET until_ms=0 WHERE provider='resend'`;
      assert.equal((await pass()).status,'succeeded');assert.equal((await pass()).status,'succeeded');
      assert.equal((await pass()).status,'idle');
      const removed=randomUUID();await submit(support,removed);
      await manageLeadForm(db,a,{action:'removeInquiry',formId:support,submissionId:removed});assert.equal((await pass()).status,'skipped');

      const stale=randomUUID();await submit(support,stale);
      await client`UPDATE portable_marketing_form_deliveries SET state='sending',attempts=1,next_at=0 WHERE workspace_id=${workspaceId} AND inquiry_id=${stale}`;
      assert.equal((await pass()).status,'uncertain');assert.equal((await pass()).status,'idle');

      await submit(support);await client`DELETE FROM portable_marketing_form_routes WHERE workspace_id=${workspaceId} AND form_id=${support}`;
      await configureMarketingForm(db,workspaceId,support,{recipients:['support@example.test'],salesforce:false},env);
      assert.equal((await pass()).status,'skipped','A restored copy must not drain old receipts after routing is recreated.');
      await assert.rejects(listMarketingFormDeliveries(db,otherWorkspace,10,env),/workspace/i);
      assert.equal(email.length,4);
    }finally{
      if(priorBinding===undefined)delete process.env.HARBOR_MARKETING_WORKSPACE_ID;
      else process.env.HARBOR_MARKETING_WORKSPACE_ID=priorBinding;
      try{await client?.end({timeout:3});await admin`DROP DATABASE IF EXISTS ${admin(name)}`;}finally{await admin.end({timeout:3});}
    }
  });
