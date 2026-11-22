import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyWorkItemHistory({get,send,other,ok,sql,workspaceId,memberId}){
  const access=await (await ok(send('/api/workspaces',{action:'record_scope',id:memberId,viewScope:'all',editScope:'all'}))).json();
  const member=access.viewers.find(person=>person.email==='other@example.test');
  const savedLinks=[];
  const name='Fictional Willow support';
  const customer=(await (await ok(send('/api/crm',{action:'save',kind:'contacts',data:{name:'Willow customer'}}))).json()).record.id;
  const events=()=>sql`SELECT id,action,kind,record_ids FROM portable_record_access_events
    WHERE workspace_id=${workspaceId} AND actor_email='other@example.test'`;
  // Compare just the receipts added by this request, even when several share a timestamp.
  async function check(path,expected,{method='GET',status=200,contains,absent,requestHeaders}={}){
    const before=new Set((await events()).map(row=>row.id));
    const response=await get(path,{...other,...requestHeaders},method);
    assert.equal(response.status,status,path);
    const body=await response.text();
    if(contains)assert.ok(body.includes(contains),path);
    if(absent)assert.ok(!body.includes(absent),path);
    const added=(await events()).filter(row=>!before.has(row.id));
    const receipts=added.map(row=>[row.action,row.kind,...row.record_ids]);
    assert.deepEqual(receipts.sort(),expected.sort(),method+' '+path);
  }
  for(const kind of ['tasks','leads','tickets']){
    const api=kind==='tasks'?'/api/crm?kind=tasks&':'/api/'+kind+'?';
    const endpoint=kind==='tasks'?'/api/crm':'/api/'+kind;
    const fields=kind==='tasks'?{kind,related:{kind:'contacts',id:customer}}:{contactId:customer};
    const created=await (await ok(send(endpoint,{action:'save',...fields,data:{name}}))).json();
    const id=kind==='leads'?created.id:created.record.id;
    const scope='workspaceId='+workspaceId;
    const filter='search='+encodeURIComponent(name);
    const list=['list',kind,id],detail=['detail',kind,id],linked=['related','contacts',customer];
    const page=kind==='tickets'?'/tickets?':'/?kind='+kind+'&';
    const listUrl=page+scope+'&'+filter;
    const detailUrl=page+scope+(kind==='tickets'?'&id=':'&'+filter+'&record=')+id;
    savedLinks.push(api+scope+'&id='+id);
    await check(api+scope+'&id='+id,[],{method:'HEAD'});
    await check(api+scope+'&id='+id,[detail,linked],{contains:name});
    await check(api+scope+'&'+filter,[list,linked],{contains:name});
    await check(listUrl,[list,linked],{contains:name,requestHeaders:{'x-harbor-page-method':'HEAD'}});
    await check(detailUrl,kind==='tickets'?[detail,linked]:[list,detail,linked],{contains:name});
    await check(api+scope+'&id='+randomUUID(),[],{status:404});
    await check(api+scope+'&search=missing-Willow',[]);
    await check(page+scope+(kind==='tickets'?'&id=':'&'+filter+'&record=')+randomUUID(),[],{status:404});
    await check(listUrl,[],{method:'HEAD'});
  }
  const propertyHistory='/api/crm?kind=contacts&workspaceId='+workspaceId+'&history='+customer;
  for(const kind of ['contacts','companies','deals']){
    const id=kind==='contacts'?customer:(await (await ok(send('/api/crm',{action:'save',kind,data:{name:'Willow account'}}))).json()).record.id;
    await check('/api/crm?'+new URLSearchParams({kind,workspaceId,history:id,field:'name'}),[['history',kind,id]],
      {contains:kind==='contacts'?'Willow customer':'Willow account'});
  }
  await check(propertyHistory+'&field=description',[]);
  await check(propertyHistory,[],{method:'HEAD'});
  const completed=await (await ok(send('/api/crm',{action:'save',kind:'tasks',related:{kind:'contacts',id:customer},
    data:{name:'Willow handoff',status:'Completed'}}))).json();
  const completions='/api/crm?kind=tasks&workspaceId='+workspaceId+'&completionHistoryFor='+customer;
  await check(completions,[['history','contacts',customer],['history','tasks',completed.record.id]],{contains:'Willow handoff'});
  await check(completions,[],{method:'HEAD'});
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT test_block_task_history CHECK (action<>'history' OR kind<>'tasks') NOT VALID`;
  try{
    await check(completions,[],{status:500,absent:'Willow handoff'});
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT test_block_task_history`;}
  for(const page of ['/?contact='+customer,'/?kind=companies','/?kind=deals&view=board']){
    await check(page+'&workspaceId='+workspaceId,[],{method:'HEAD'});
  }
  // Rejecting a linked customer receipt must also roll back the Task, Lead or Ticket detail entry.
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT test_block_link CHECK (action<>'related') NOT VALID`;
  try{
    for(const path of savedLinks){
      await check(path,[],{status:path.startsWith('/api/tickets?')?503:500});
    }
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT test_block_link`;}
  savedLinks.push(propertyHistory,completions);
  const editor=await (await ok(send('/api/workspaces',{action:'role',id:member.id,role:'editor'}))).json();
  const editGrant=editor.viewers.find(person=>person.email==='other@example.test');
  const narrowed=await (await ok(send('/api/workspaces',{action:'record_scope',id:editGrant.id,viewScope:'owned',editScope:'owned'}))).json();
  const [rep]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  for(const kind of ['tasks','leads']){
    const endpoint=kind==='tasks'?'/api/crm':'/api/leads';
    const fields=kind==='tasks'?{kind,related:{kind:'contacts',id:customer}}:{contactId:customer};
    const created=await (await ok(send(endpoint,{action:'save',...fields,data:{name:'My Willow follow-up'},assigneeId:rep.id}))).json();
    const id=kind==='tasks'?created.record.id:created.id;
    const path=endpoint+'?'+new URLSearchParams({...(kind==='tasks'?{kind}:{}),workspaceId,id});
    await check(path,[['detail',kind,id]],{contains:'My Willow follow-up',absent:customer});
    savedLinks.push(path);
  }
  const latest=narrowed.viewers.find(person=>person.email==='other@example.test');
  await ok(send('/api/workspaces',{action:'revoke',id:latest.id}));
  for(const path of savedLinks)await check(path,[],{status:404});
}
