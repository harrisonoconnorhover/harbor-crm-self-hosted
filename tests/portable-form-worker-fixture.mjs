import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {drizzle} from 'drizzle-orm/postgres-js';
import 'tsx/esm';

const {configureMarketingForm,listMarketingFormDeliveries}=await import('../db/postgres/marketing-form-store.ts');
const {manageLeadForm,submitLeadInquiry}=await import('../db/postgres/lead-form-store.ts');

export async function prepareWorkerForm(sql,workspaceId){
  const db=drizzle(sql),formId=randomUUID(),destination='sales@example.test';
  const env={HARBOR_MARKETING_WORKSPACE_ID:workspaceId,HARBOR_MARKETING_FORM_RECIPIENTS:destination};
  await manageLeadForm(db,workspaceId,{action:'save',id:formId,revision:0,definition:{
    title:'Talk with Sales',description:'',thankYou:'Thanks',embedOrigin:'https://fictional.example.test',
    captureContacts:false,queueWorkflows:false,
  }});
  await manageLeadForm(db,workspaceId,{action:'setEnabled',id:formId,revision:1,enabled:true});
  await configureMarketingForm(db,workspaceId,formId,{recipients:[destination],salesforce:false},env);
  async function submit(){
    const id=randomUUID(),previous=process.env.HARBOR_MARKETING_WORKSPACE_ID;
    process.env.HARBOR_MARKETING_WORKSPACE_ID=workspaceId;
    try{
      await submitLeadInquiry(db,formId,workspaceId,{id,revision:2,website:'',
        payload:{name:'Riley Example',email:'riley@example.test',phone:'',message:id}},'fingerprint-'+id);
    }finally{
      if(previous===undefined)delete process.env.HARBOR_MARKETING_WORKSPACE_ID;
      else process.env.HARBOR_MARKETING_WORKSPACE_ID=previous;
    }
    return id;
  }
  async function verify(ids,calls){
    const rows=await listMarketingFormDeliveries(db,workspaceId,100,env);
    assert.equal(rows.length,ids.length);
    assert.equal(calls.length,ids.length);
    for(const id of ids){
      const delivery=rows.find(row=>row.inquiryId===id);
      assert.ok(delivery);
      assert.equal(delivery.state,'succeeded');
      assert.equal(delivery.attempts,1);
      const key='harbor-form-'+delivery.id;
      assert.equal(delivery.receipt,'local-'+key);
      const call=calls.find(item=>item.key===key);
      assert.ok(call);
      assert.deepEqual(call.to,[destination]);
      assert.ok(call.text.includes(id));
    }
  }
  return {submit,verify};
}
