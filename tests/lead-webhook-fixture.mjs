import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyLeadWebhook({request,origin,owner,other}){
  const post=(path,body,actor,headers={})=>request(path,{method:'POST',
    headers:{'content-type':'application/json',...(actor===null?{}:{origin}),...headers},body:JSON.stringify(body)},actor);
  const requireStatus=async(response,status)=>{
    assert.equal(response.status,status,await response.clone().text());
    return response.json();
  };
  const newToken=(actor,objects=['inquiries'],permission='read_write')=>
    post('/api/api-tokens',{name:'Fictional website backend',objects,permission,days:30},actor);
  const {token,info}=await requireStatus(await newToken(owner),201);
  assert.deepEqual(info.scopes,['inquiries:write']);
  const foreign=await requireStatus(await newToken(other),201);
  const readOnly=await requireStatus(await newToken(owner,['contacts'],'read'),201);
  await requireStatus(await newToken(owner,['inquiries','contacts']),400);
  const id=randomUUID(),definition={title:'Fictional inbound form',captureContacts:false};
  const save=(revision,fields=definition)=>post('/api/lead-forms',{action:'save',id,revision,definition:fields},owner);
  const setEnabled=(revision,enabled)=>post('/api/lead-forms',{action:'setEnabled',id,revision,enabled},owner);
  const path='/api/v1/forms/'+id+'/inquiries';
  const input={id:randomUUID(),payload:{name:'Fictional visitor',email:'webhook-'+id+'@example.test',message:'Fictional inbound inquiry'}};
  const headers=secret=>secret?{authorization:'Bearer '+secret}:{};
  const send=(secret,body=input)=>post(path,body,null,headers(secret));
  await requireStatus(await save(0),200);
  await requireStatus(await send(token),404);
  await requireStatus(await setEnabled(1,true),200);
  const anonymous=await send();
  assert.equal(anonymous.headers.get('www-authenticate'),'Bearer');
  await requireStatus(anonymous,401);
  await requireStatus(await post(path,input,owner),401);
  await requireStatus(await send(foreign.token),404);
  await requireStatus(await send(readOnly.token),403);
  await requireStatus(await request('/api/v1/records/contacts',{headers:headers(token)},null),403);
  await requireStatus(await send(token,{...input,payload:{...input.payload,message:'a'.repeat(32768)}}),413);
  const accepted=await send(token);
  assert.match(accepted.headers.get('cache-control'),/no-store/);
  assert.deepEqual(await requireStatus(accepted,200),{accepted:true});
  await requireStatus(await save(2,{...definition,title:'Renamed fictional form'}),200);
  assert.deepEqual(await requireStatus(await send(token),200),{accepted:true});
  await requireStatus(await send(token,{...input,payload:{...input.payload,message:'Different content'}}),409);
  const inbox=await requireStatus(await request('/api/lead-forms?formId='+id,{},owner),200);
  assert.equal(inbox.results.length,1);
  const [inquiry]=inbox.results;
  assert.deepEqual([inquiry.id,inquiry.status,inquiry.contactId||null,inquiry.payload.message],
    [input.id,'inbox_only',null,input.payload.message]);
  await requireStatus(await save(3,{...definition,captureContacts:true}),200);
  await requireStatus(await send(token,{...input,id:randomUUID()}),404);
  await requireStatus(await post('/api/api-tokens',{action:'revoke',id:info.id},owner),200);
  await requireStatus(await send(token),401);
  return {id,inquiryId:input.id};
}
