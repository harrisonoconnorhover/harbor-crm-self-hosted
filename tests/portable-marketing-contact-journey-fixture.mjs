import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import 'tsx/esm';
import {sendMarketingEmail} from '../lib/marketing-mail-transport.mjs';

const {runMarketingFormPass,listMarketingFormDeliveries}=await import('../db/postgres/marketing-form-store.ts');
const {deliverSalesforceInquiry}=await import('../lib/marketing-form-delivery.ts');
const {salesforceApiFromEnv,salesforceAudienceSourceFromEnv}=await import('../lib/marketing-salesforce.ts');
const {syncMarketingAudience}=await import('../db/postgres/marketing-audience-store.ts');
export const {runMarketingCampaignPass}=await import('../db/postgres/marketing-campaign-store.ts');

// Only the two provider transports are simulated. Forms, receipts, campaigns and opt-outs use the built app and PostgreSQL.
export async function verifyMarketingContactJourney({db,ws,env,mailEnv,api,manager,form,inquiry,origin,cookie,designId,feedback}){
  const visitor=inquiry.payload.email,control='other-subscriber@example.test';
  const operator={...env,...mailEnv,HARBOR_SALESFORCE_CLIENT_ID:'fixture',HARBOR_SALESFORCE_CLIENT_SECRET:'fixture',
    HARBOR_SALESFORCE_AUDIENCE_MAPPING:JSON.stringify({consentField:'Consent__c',accountFields:[]})};
  const mail=[],inquiries=[];
  async function mailTransport(url,request){
    assert.equal(String(url),'https://api.resend.com/emails');
    const message=JSON.parse(request.body);
    mail.push(message);
    return Response.json({id:message.tags?'local-'+message.tags[0].value:'local-sales-notification'});
  }
  async function salesforceTransport(input,request){
    const url=new URL(input);
    assert.equal(url.origin,operator.HARBOR_SALESFORCE_ORIGIN);
    if(url.pathname==='/services/oauth2/token')return Response.json({instance_url:url.origin,access_token:'fictional'});
    if(request.method==='PATCH'){
      assert.equal(url.pathname,'/services/data/v64.0/sobjects/Inquiry__c/Harbor_Key__c/'+ws+'-'+inquiry.id);
      inquiries.push(JSON.parse(request.body));
      return Response.json({id:'a00123456789012',success:true},{status:201});
    }
    assert.equal(url.pathname,'/services/data/v64.0/query');
    const query=url.searchParams.get('q');
    let records=[];
    if(query.includes(' FROM Contact ')){
      // Both Salesforce Contacts independently granted marketing consent before submitting any form.
      records=[visitor,control].map((Email,index)=>({Id:'00300000000000'+(index+1),Email,AccountId:null,
        HasOptedOutOfEmail:false,Consent__c:true}));
    }else assert.match(query,/ FROM Account /);
    return Response.json({done:true,totalSize:records.length,records});
  }
  const notify=message=>sendMarketingEmail(message,operator,mailTransport);
  const providers={notify,upsert:input=>deliverSalesforceInquiry(input,operator,e=>salesforceApiFromEnv(e,salesforceTransport),salesforceTransport)};
  const pass=()=>runMarketingFormPass(db,ws,operator,providers);
  assert.deepEqual((await Promise.all([pass(),pass()])).map(r=>r.status),['succeeded','succeeded']);
  // The same public submission is replayed again after both providers acknowledged it.
  assert.equal((await manager(inquiry,'/api/public/forms/'+form,false)).status,200);
  assert.equal((await pass()).status,'idle');
  assert.deepEqual(mail.map(m=>m.to),[['sales@example.test']]);
  assert.ok(mail[0].text.includes(visitor));
  assert.deepEqual(inquiries,[{Name:inquiry.payload.name,Email__c:visitor}]);
  const recent=(await (await api({action:'formSettings'})).json()).recent;
  assert.deepEqual(recent.map(r=>[r.kind,r.state]).sort(),[['email','succeeded'],['salesforce','succeeded']]);
  const receipts=await listMarketingFormDeliveries(db,ws,10,operator);
  assert.equal(receipts.length,2);
  assert.ok(receipts.every(r=>r.inquiryId===inquiry.id&&r.attempts===1&&r.state==='succeeded'&&r.receipt));
  await syncMarketingAudience(db,ws,salesforceAudienceSourceFromEnv(operator,salesforceTransport));
  async function campaign(name,expected){
    const preview=await (await api({action:'preview',filter:{}})).json();
    assert.deepEqual(preview.emails.slice().sort(),expected.slice().sort());
    const id=randomUUID();
    const queued=await api({action:'queue',id,name,designId,designRevision:2,expectedTotal:expected.length,
      snapshot:preview.status.generation,filter:{}});
    assert.equal(queued.status,200,await queued.clone().text());
    const start=mail.length;
    for(let i=0;i<expected.length;i++)assert.equal(await runMarketingCampaignPass(db,ws,operator,notify),'accepted');
    assert.equal(await runMarketingCampaignPass(db,ws,operator,notify),'idle');
    const sent=mail.slice(start);
    assert.deepEqual(sent.map(m=>m.to[0]).sort(),expected.slice().sort());
    return {id,sent};
  }
  const first=await campaign('Visitor welcome',[visitor,control]);
  const message=first.sent.find(m=>m.to[0]===visitor);
  const receipt=m=>({to:m.to[0],tag:m.tags.find(t=>t.name==='harbor_delivery').value});
  assert.equal((await feedback('email.delivered',receipt(message))).status,204);
  const link=new URL(message.headers['List-Unsubscribe'].slice(1,-1));
  assert.equal((await fetch(origin+link.pathname+link.search,{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},body:'List-Unsubscribe=One-Click'})).status,204);
  if(process.env.HARBOR_TEST_PLAYWRIGHT){
    const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
    const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
    try{
      const page=await browser.newPage();
      const [name,value]=cookie.split('=');
      await page.context().addCookies([{name,value,url:origin}]);
      await page.goto(origin+'/?view=email-settings#email-suppressions');
      const panel=page.getByRole('region',{name:'Do not email'});
      await panel.getByLabel('Search blocked addresses').fill(visitor.toUpperCase());
      const searched=page.waitForResponse(response=>new URL(response.url()).searchParams.get('query')===visitor.toUpperCase());
      await panel.getByRole('button',{name:'Search blocks'}).click();
      assert.ok((await searched).ok());
      await panel.getByText('1 matching blocked address',{exact:true}).waitFor();
      const row=panel.getByRole('listitem').filter({hasText:visitor});
      await row.getByText('Recipient unsubscribed',{exact:true}).waitFor();
      assert.equal(await row.getByRole('button').count(),0);
    }finally{await browser.close();}
  }
  const next=await campaign('Visitor follow-up',[control]);
  const event=receipt(next.sent[0]);
  const states=async()=> (await (await api()).json()).campaigns.find(c=>c.id===next.id).states;
  assert.deepEqual(await states(),{accepted:1});
  assert.equal((await feedback('email.suppressed',event,false)).status,401);
  assert.deepEqual(await states(),{accepted:1});
  for(const type of ['email.suppressed','email.suppressed','email.delivered']){
    assert.equal((await feedback(type,event)).status,204);
    assert.deepEqual(await states(),{suppressed:1});
  }
  assert.deepEqual((await (await api({action:'preview',filter:{}})).json()).emails,[control]);
}
