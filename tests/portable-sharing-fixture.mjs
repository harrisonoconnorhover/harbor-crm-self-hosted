import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {verifyPortableSharedFiles} from './portable-files-fixture.mjs';
import {prepareWorkspaceFileRevocation,verifyWorkspaceRevocation} from './workspace-revocation-fixture.mjs';

export async function verifyPortableReplicaRevocation({
  source,replica,sourceOrigin,replicaOrigin,sourceOwner,replicaMember,memberEmail,recordId,personalId,files,
}){
  const postHeaders=(auth,origin)=>({...auth,origin,'content-type':'application/json'});
  const change=async data=>{
    const response=await source('/api/workspaces',{method:'POST',headers:postHeaders(sourceOwner,sourceOrigin),
      body:JSON.stringify(data)});
    assert.equal(response.status,200,'owner changes workspace access via process A: '+data.action);
    return response;
  };
  const grant=async data=>(await (await change(data)).json()).viewers.find(member=>member.email===memberEmail);
  const initial=await change({action:'grant',email:memberEmail});
  const {owned:workspaceId,viewers}=await initial.json();
  const viewer=viewers.find(member=>member.email===memberEmail);
  assert.ok(workspaceId&&viewer);
  let editor=await grant({action:'role',id:viewer.id,role:'editor'});
  if(files)editor=await grant({action:'contact_files',id:editor.id,enabled:true});
  const contactPath='/api/crm?kind=contacts&id='+recordId;
  const readOwner=()=>source(contactPath,{headers:sourceOwner});
  const readShared=()=>replica(contactPath+'&workspaceId='+workspaceId,{headers:replicaMember});
  const original=await readOwner();
  assert.equal(original.status,200);

  let verifyFileRemoved;
  if(files){
    const bytes=Uint8Array.of(17,41,59);
    const path='/api/record-attachments?'+new URLSearchParams({recordId,fileId:randomUUID(),versionId:randomUUID()});
    const uploaded=await source(path,{method:'POST',headers:{...sourceOwner,origin:sourceOrigin,
      'x-harbor-file-name':'Replica%20sharing%20proof.txt'},body:bytes});
    assert.equal(uploaded.status,200);
    verifyFileRemoved=await prepareWorkspaceFileRevocation({bytes,
      readMember:()=>replica(path+'&workspaceId='+workspaceId,{headers:replicaMember}),
      readOwner:()=>source(path,{headers:sourceOwner})});
  }

  await verifyWorkspaceRevocation({
    targetId:recordId,editedName:(await original.json()).data.name,personalId,deniedWriteStatus:403,
    readShared,readOwner,readPersonal:()=>replica('/api/crm?kind=contacts&id='+personalId,{headers:replicaMember}),
    snapshot:({id,data,revision})=>({id,name:data.name,version:revision}),
    prepareWrite:({id,data,revision},name)=>()=>replica('/api/crm?'+new URLSearchParams({workspaceId,grantId:editor.id}),{
      method:'POST',headers:postHeaders(replicaMember,replicaOrigin),
      body:JSON.stringify({action:'save',kind:'contacts',id,expectedRevision:revision,data:{...data,name}}),
    }),
    revoke:()=>change({action:'revoke',id:editor.id}),
  });
  assert.equal((await readShared()).status,404,'repeat read on process B still denies the revoked session');
  await verifyFileRemoved?.();
}

export async function verifyPortableSharing({request,origin,headers,other,record,company,deal,sql,fixture}){
  const endpoint='/api/workspaces';
  const listing=auth=>request(endpoint,{headers:auth});
  const change=(auth,data,site=origin)=>request(endpoint,{method:'POST',headers:{
    ...auth,origin:site,'content-type':'application/json',
  },body:JSON.stringify(data)});
  assert.equal((await listing({})).status,401);
  const owner=await (await listing(headers)).json();
  const workspaceId=owner.owned;
  assert.ok(workspaceId);
  assert.deepEqual(owner.viewers,[]);
  const scoped='?workspaceId='+workspaceId;
  const records=(auth,query='')=>request('/api/crm'+scoped+query,{headers:auth});
  const historyQuery='&kind=tasks&completionHistoryFor='+record.id;
  const history='/api/crm?'+historyQuery.slice(1);
  const propertyHistory='&kind=companies&history='+company.id+'&field=city';

  assert.equal((await records(other)).status,404);
  assert.equal((await request('/'+scoped,{headers:other})).status,404);
  const linkedDeals='&kind=deals&companyId='+company.id;
  assert.equal((await records(other,linkedDeals)).status,404);
  assert.equal((await records(other,historyQuery)).status,404);
  assert.equal((await records(other,propertyHistory)).status,404);
  const mineQuery='&kind=tasks&taskView=mine';
  assert.equal((await records(other,mineQuery)).status,404);
  assert.equal((await records(other,'&kind=tasks&taskView=today')).status,404);
  const grant={action:'grant',email:'OTHER@example.test'};
  assert.equal((await change(headers,grant,'https://foreign.example.test')).status,403);
  assert.equal((await change(headers,{...grant,email:'unknown@example.test'})).status,404);
  assert.equal((await change(headers,{...grant,email:'owner@example.test'})).status,404);
  const response=await change(headers,grant);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  const {viewers}=await response.json();
  assert.equal(viewers.length,1);
  assert.equal(viewers[0].email,'other@example.test');
  assert.equal(viewers[0].role,'viewer');
  assert.deepEqual((await (await change(headers,grant)).json()).viewers,viewers);
  assert.deepEqual((await (await listing(other)).json()).shared,[{id:workspaceId,ownerEmail:'owner@example.test',
    role:'viewer',contactFiles:false,scheduledNotes:false,contactOutreach:false,recordActivities:false,backupAdmin:false,grantId:viewers[0].id}]);
  assert.equal((await records({})).status,401);
  for(const [kind,item] of [['contacts',record],['companies',company],['deals',deal]]){
    const visible=await records(other,'&kind='+kind+'&id='+item.id);
    assert.equal(visible.status,200);
    assert.equal(visible.headers.get('cache-control'),'no-store');
    assert.equal((await visible.json()).id,item.id);
    assert.equal((await request('/api/crm?kind='+kind+'&id='+item.id,{headers:other})).status,404);
    assert.equal((await request('/api/crm'+scoped+'&grantId='+viewers[0].id,{method:'POST',headers:{
      ...other,origin,'content-type':'application/json',
    },body:JSON.stringify({action:'save',kind,id:item.id,expectedRevision:item.revision,data:item.data})})).status,403);
  }
  const sharedPage=await request('/'+scoped+'&kind=deals',{headers:other});
  assert.equal(sharedPage.status,200);
  assert.match(sharedPage.headers.get('cache-control')||'',/no-store/);
  const html=await sharedPage.text();
  assert.match(html,/View only/);
  assert.match(html,/Owner Deal/);
  assert.doesNotMatch(html,/<button[^>]*>Add deal/);
  assert.doesNotMatch(html,/Other Deal/);
  const companyDetail=await (await request('/'+scoped+'&kind=companies&record='+company.id,{headers:other})).text();
  const relatedPath=companyDetail.match(/href="([^"]+)">Linked deals<\/a>/)?.[1].replaceAll('&amp;','&');
  assert.ok(relatedPath);
  assert.equal(new URL(relatedPath,origin).searchParams.get('workspaceId'),workspaceId);
  const relatedPage=await request(relatedPath,{headers:other});
  assert.equal(relatedPage.status,200);
  const relatedHtml=await relatedPage.text();
  assert.match(relatedHtml,/Deals linked to Owner Company/);
  assert.match(relatedHtml,/Owner Deal/);
  assert.doesNotMatch(relatedHtml,/Owner Second Deal|Other Deal/);
  assert.equal((await records({},linkedDeals)).status,401);
  const visibleHistory=await records(other,propertyHistory);
  assert.equal(visibleHistory.status,200);
  assert.equal((await visibleHistory.json()).items[0].value,company.data.city);
  for(const route of ['/api/record-attachments','/api/background-jobs']){
    assert.equal((await request(route+'?recordId='+record.id,{headers:other})).status,404);
  }
  const revoke={action:'revoke',id:viewers[0].id};
  assert.equal((await change(other,revoke)).status,404);
  assert.equal((await change(headers,revoke)).status,200);
  assert.equal((await records(other)).status,404);
  assert.equal((await request('/'+scoped,{headers:other})).status,404);
  assert.equal((await records(other,linkedDeals)).status,404);
  assert.equal((await records(other,historyQuery)).status,404);
  assert.equal((await records(other,propertyHistory)).status,404);
  assert.equal((await request(relatedPath,{headers:other})).status,404);
  const regrant=await change(headers,grant);
  assert.equal(regrant.status,200);
  const [viewer]=(await regrant.json()).viewers;
  assert.notEqual(viewer.id,viewers[0].id);
  assert.equal((await change(headers,revoke)).status,404);
  assert.equal((await records(other)).status,200);
  const promote={action:'role',id:viewer.id,role:'editor'};
  assert.equal((await change(other,promote)).status,404);
  const promoted=await change(headers,promote);
  assert.equal(promoted.status,200);
  let [editor]=(await promoted.json()).viewers;
  assert.equal(editor.role,'editor');
  assert.notEqual(editor.id,viewer.id);
  assert.equal((await change(headers,{action:'revoke',id:viewer.id})).status,404);
  const write=(grantId,kind,body)=>request('/api/crm'+scoped+'&grantId='+grantId,{method:'POST',headers:{
    ...other,origin,'content-type':'application/json',
  },body:JSON.stringify({action:'save',kind,...body})});
  assert.equal((await write(viewer.id,'contacts',{data:{name:'Old grant rejected'}})).status,403);
  const [foreignCompany,foreignContact,foreignDeal]=await Promise.all(['companies','contacts','deals'].map(async kind=>
    (await (await request('/api/crm?kind='+kind,{headers:other})).json()).records[0]));
  assert.equal((await write(editor.id,'contacts',{data:{name:'Foreign company rejected'},primaryCompanyId:foreignCompany.id})).status,404);
  assert.equal((await write(editor.id,'deals',{data:{name:'Foreign company rejected'},companyId:foreignCompany.id})).status,404);
  assert.equal((await write(editor.id,'deals',{data:{name:'Foreign contact rejected'},primaryContactId:foreignContact.id})).status,404);
  assert.deepEqual((await (await records(other,'&kind=contacts&search=Other')).json()).records,[]);
  const [identity]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const edits=[];
  for(const [kind,table,foreignKey] of [['contacts','contact_events','contact_id'],['companies','company_events','company_id'],['deals','deal_events','deal_id']]){
    const links=kind==='deals'?{companyId:company.id,primaryContactId:record.id}:
      kind==='contacts'?{primaryCompanyId:company.id}:{};
    const create=await write(editor.id,kind,{data:{name:'Editor created '+kind},...links});
    assert.equal(create.status,201);
    const {record:created}=await create.json();
    const update=await write(editor.id,kind,{id:created.id,expectedRevision:1,data:{...created.data,name:'Editor changed '+kind}});
    assert.equal(update.status,200);
    const revision=await sql`SELECT actor_id,workspace_id FROM ${sql(table)} WHERE ${sql(foreignKey)}=${created.id} ORDER BY revision`;
    assert.deepEqual(revision.map(row=>[row.actor_id,row.workspace_id]),[[identity.id,workspaceId],[identity.id,workspaceId]]);
    const ownerRead=await request('/api/crm?kind='+kind+'&id='+created.id,{headers});
    assert.equal(ownerRead.status,200);
    const persisted=await ownerRead.json();
    assert.equal(persisted.data.name,'Editor changed '+kind);
    if(kind==='deals')assert.deepEqual([persisted.companyId,persisted.primaryContactId],[company.id,record.id]);
    edits.push({kind,id:created.id,name:'Editor changed '+kind});
    if(kind==='contacts'){
      const revokedEditor=editor;
      const privateContact=(id,auth)=>request('/api/crm?kind=contacts&id='+id,{headers:auth});
      const prepareEdit=(grantId,{id,data,revision},name)=>()=>write(grantId,'contacts',{id,expectedRevision:revision,data:{...data,name}});
      const verifyRegrant=await verifyWorkspaceRevocation({
        targetId:created.id,editedName:persisted.data.name,personalId:foreignContact.id,deniedWriteStatus:403,
        readShared:()=>records(other,'&kind=contacts&id='+created.id),
        readOwner:()=>privateContact(created.id,headers),
        readPersonal:()=>privateContact(foreignContact.id,other),
        snapshot:({id,data,revision})=>({id,name:data.name,version:revision}),
        prepareWrite:(record,name)=>prepareEdit(revokedEditor.id,record,name),
        revoke:()=>change(headers,{action:'revoke',id:revokedEditor.id}),
      });
      const restored=await change(headers,grant);
      assert.equal(restored.status,200);
      const [newViewer]=(await restored.json()).viewers;
      const restoredEditor=await change(headers,{...promote,id:newViewer.id});
      assert.equal(restoredEditor.status,200);
      [editor]=(await restoredEditor.json()).viewers;
      assert.notEqual(editor.id,revokedEditor.id);
      const freshName='Reinstated editor changed contacts';
      await verifyRegrant({regrantedWriteStatus:403,freshName,
        prepareFreshWrite:(record,name)=>prepareEdit(editor.id,record,name)});
      edits.at(-1).name=freshName;
    }
  }
  const linkedContactDeals='&kind=deals&primaryContactId='+record.id+'&limit=1';
  const firstLinkPage=await (await records(other,linkedContactDeals)).json();
  assert.equal(firstLinkPage.records.length,1);
  assert.equal(firstLinkPage.next,firstLinkPage.records[0].id);
  const secondLinkPage=await (await records(other,linkedContactDeals+'&after='+firstLinkPage.next)).json();
  assert.deepEqual(new Set([...firstLinkPage.records,...secondLinkPage.records].map(item=>item.id)),
    new Set([deal.id,edits.find(item=>item.kind==='deals').id]));
  assert.equal(secondLinkPage.next,null);
  const [ownerIdentity]=await sql`SELECT id FROM login_identities WHERE email='owner@example.test'`;
  // Give the local Tasks case its own request budget, independent of earlier fixture cases.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
    AND subject IN (${ownerIdentity.id},${identity.id})`;
  const outreach='/api/logged-activities?contactId='+record.id;
  const beforeTaskOutreachResponse=await request(outreach,{headers});
  assert.equal(beforeTaskOutreachResponse.status,200);
  const beforeTaskOutreach=await beforeTaskOutreachResponse.json();
  const ownerTask=body=>request('/api/crm',{method:'POST',headers:{
    ...headers,origin,'content-type':'application/json',
  },body:JSON.stringify({action:'save',kind:'tasks',...body})});
  const taskData={name:'Follow up on the proposal',notes:'Review with the contact',taskType:'Call',
    priority:'High',dueDate:'2026-11-10'};
  assert.equal((await write(editor.id,'tasks',{data:taskData,contactId:foreignContact.id})).status,404);
  const createdTaskResponse=await ownerTask({data:taskData,assigneeId:identity.id,contactId:record.id});
  assert.equal(createdTaskResponse.status,201);
  const {record:createdTask}=await createdTaskResponse.json();
  assert.equal(createdTask.revision,1);
  assert.equal(createdTask.data.status,'Not started');
  assert.equal(createdTask.assigneeId,identity.id);
  assert.equal(createdTask.contactId,record.id);
  assert.equal(createdTask.completedAt,null);
  const taskQuery='&kind=tasks&id='+createdTask.id;
  assert.equal((await request('/api/crm?kind=tasks&id='+createdTask.id,{headers:other})).status,404);
  const activeTasks=await (await records(other,'&kind=tasks&contactId='+record.id+'&status=Not%20started')).json();
  assert.deepEqual(activeTasks.records.map(item=>item.id),[createdTask.id]);
  const privateMine='/api/crm?'+mineQuery.slice(1);
  const mine=async(query='')=>{
    const response=await records(other,mineQuery+query);
    assert.equal(response.status,200);
    return response.json();
  };
  assert.deepEqual(await mine('&contactId='+record.id),{records:[createdTask],next:null});
  for(const auth of [headers,other]){
    assert.deepEqual(await (await request(privateMine,{headers:auth})).json(),{records:[],next:null});
  }
  for(const invalid of ['&status=Completed','&assigneeId='+ownerIdentity.id,'&id='+createdTask.id]){
    assert.equal((await records(other,mineQuery+invalid)).status,400);
  }
  const minePath='/'+scoped+mineQuery+'&contactId='+record.id;
  const minePage=await request(minePath,{headers:other});
  assert.equal(minePage.status,200);
  const mineHtml=await minePage.text();
  const mineLink=mineHtml.match(/href="([^"]+)" aria-current="page">My tasks<\/a>/)?.[1].replaceAll('&amp;','&');
  const mineParams=new URL(mineLink,origin).searchParams;
  assert.equal(mineParams.get('taskView'),'mine');
  assert.equal(mineParams.get('workspaceId'),workspaceId);
  assert.equal(mineParams.get('contactId'),record.id);
  assert.match(mineHtml,/<a [^>]+>Follow up on the proposal<\/a>/);
  assert.equal((await request(minePath+'&record='+createdTask.id,{headers:other})).status,200);
  const completeTask={id:createdTask.id,expectedRevision:1,data:{...createdTask.data,status:'Completed'}};
  assert.equal((await write(viewers[0].id,'tasks',completeTask)).status,403);
  const completedTaskResponse=await write(editor.id,'tasks',completeTask);
  assert.equal(completedTaskResponse.status,200);
  const {record:firstCompletion}=await completedTaskResponse.json();
  assert.equal(firstCompletion.revision,2);
  assert.equal(firstCompletion.data.status,'Completed');
  assert.equal(firstCompletion.assigneeId,createdTask.assigneeId);
  assert.equal(firstCompletion.contactId,createdTask.contactId);
  assert.ok(Number.isFinite(Date.parse(firstCompletion.completedAt)));
  assert.deepEqual(await mine(),{records:[],next:null});
  assert.equal((await request(minePath+'&record='+createdTask.id,{headers:other})).status,404);
  assert.equal((await records(other,taskQuery)).status,200);
  assert.equal((await ownerTask(completeTask)).status,409);
  assert.deepEqual(await (await request('/api/crm?kind=tasks&id='+createdTask.id,{headers})).json(),firstCompletion);
  const taskEvents=await sql`SELECT revision,actor_id,workspace_id FROM portable_task_events
    WHERE task_id=${createdTask.id} ORDER BY revision`;
  assert.deepEqual(taskEvents.map(event=>[event.revision,event.actor_id,event.workspace_id]),[
    [1,ownerIdentity.id,workspaceId],
    [2,identity.id,workspaceId],
  ]);
  const completionEdit=await ownerTask({id:createdTask.id,expectedRevision:firstCompletion.revision,
    data:{...firstCompletion.data,notes:'Proposal reviewed'}});
  assert.equal(completionEdit.status,200);
  const {record:editedCompletion}=await completionEdit.json();
  assert.equal(editedCompletion.completedAt,firstCompletion.completedAt);
  const reopen=await write(editor.id,'tasks',{id:createdTask.id,expectedRevision:editedCompletion.revision,
    data:{...editedCompletion.data,status:'Not started'}});
  assert.equal(reopen.status,200);
  const {record:reopenedTask}=await reopen.json();
  assert.equal(reopenedTask.data.status,'Not started');
  assert.equal(reopenedTask.completedAt,null);
  assert.deepEqual(await mine(),{records:[reopenedTask],next:null});
  const reopenedHistory=await (await request(history,{headers})).json();
  assert.equal(reopenedHistory.items.length,1);
  assert.equal(reopenedHistory.items[0].occurredAt,firstCompletion.completedAt);

  const recomplete=await write(editor.id,'tasks',{id:createdTask.id,expectedRevision:reopenedTask.revision,
    data:{...reopenedTask.data,status:'Completed'}});
  assert.equal(recomplete.status,200);
  const {record:recompletedTask}=await recomplete.json();
  assert.equal(recompletedTask.revision,5);
  assert.equal(recompletedTask.data.status,'Completed');
  assert.ok(Number.isFinite(Date.parse(recompletedTask.completedAt)));
  const replacementContact=edits.find(item=>item.kind==='contacts').id;
  const relinked=await ownerTask({id:recompletedTask.id,expectedRevision:recompletedTask.revision,contactId:replacementContact,
    data:{...recompletedTask.data,name:'Renamed after completion'}});
  assert.equal(relinked.status,200);
  const {record:contactTask}=await relinked.json();
  assert.equal(contactTask.contactId,replacementContact);
  assert.equal(contactTask.completedAt,recompletedTask.completedAt);

  const linked={kind:'companies',id:company.id};
  for(const related of [{kind:'companies',id:foreignCompany.id},{kind:'deals',id:foreignDeal.id}]){
    assert.equal((await write(editor.id,'tasks',{data:taskData,related})).status,404);
  }
  assert.equal((await ownerTask({data:taskData,contactId:record.id,related:linked})).status,400);
  assert.equal((await records(other,'&kind=tasks&companyId='+company.id+'&dealId='+deal.id)).status,400);

  const companyLinked=await write(editor.id,'tasks',{data:{...taskData,name:'Company follow-up'},related:linked});
  assert.equal(companyLinked.status,201);
  const {record:companyTask}=await companyLinked.json();
  assert.deepEqual([companyTask.contactId,companyTask.companyId,companyTask.companyName,companyTask.dealId],
    [null,company.id,company.data.name,null]);

  const dealLinked=await ownerTask({id:contactTask.id,expectedRevision:contactTask.revision,
    data:contactTask.data,related:{kind:'deals',id:deal.id}});
  assert.equal(dealLinked.status,200);
  const {record:dealTask}=await dealLinked.json();
  assert.deepEqual([dealTask.contactId,dealTask.companyId,dealTask.dealId,dealTask.dealName,dealTask.completedAt],
    [null,null,deal.id,deal.data.name,recompletedTask.completedAt]);
  const preserved=await write(editor.id,'tasks',{id:dealTask.id,expectedRevision:dealTask.revision,data:dealTask.data});
  assert.equal(preserved.status,200);
  const {record:preservedTask}=await preserved.json();
  assert.equal(preservedTask.dealId,deal.id);
  const legacy=await ownerTask({id:preservedTask.id,expectedRevision:preservedTask.revision,data:preservedTask.data,contactId:null});
  assert.equal(legacy.status,200);
  const {record:task}=await legacy.json();
  assert.equal(task.dealId,deal.id);
  assert.equal((await ownerTask({id:companyTask.id,expectedRevision:companyTask.revision,data:companyTask.data,related:null})).status,200);
  const cleared=await (await request('/api/crm?kind=tasks&id='+companyTask.id,{headers})).json();
  assert.deepEqual([cleared.contactId,cleared.companyId,cleared.dealId],[null,null,null]);
  const timed={dueDate:'2026-11-01',dueTime:'01:30',dueTimeZone:'America/New_York'};
  const ambiguous=await ownerTask({data:{...cleared.data,...timed}});
  assert.equal(ambiguous.status,400);
  assert.match((await ambiguous.json()).error,/occurs twice/);
  const gap=await ownerTask({data:{...cleared.data,...timed,dueDate:'2026-03-08',dueTime:'02:30'}});
  assert.equal(gap.status,400);
  assert.match((await gap.json()).error,/does not exist/);
  assert.equal((await ownerTask({data:{...cleared.data,dueAt:'2099-01-01T00:00:00.000Z'}})).status,400);

  const attached=await write(editor.id,'tasks',{id:cleared.id,expectedRevision:cleared.revision,
    data:{...cleared.data,...timed,dueTimeOccurrence:'later'},related:linked});
  assert.equal(attached.status,200);
  const {record:timedTask}=await attached.json();
  assert.equal(timedTask.data.dueAt,'2026-11-01T06:30:00.000Z');
  const {dueDate:_,dueTime:__,dueTimeZone:___,dueTimeOccurrence:____,dueAt:_____,...ordinary}=timedTask.data;
  const legacyChange=await ownerTask({id:timedTask.id,expectedRevision:timedTask.revision,data:ordinary});
  assert.equal(legacyChange.status,200);
  const {record:restoredCompanyTask}=await legacyChange.json();
  assert.equal(restoredCompanyTask.data.dueAt,timedTask.data.dueAt,'An older payload can edit without erasing the timed deadline.');
  const timedPage=await request('/?kind=tasks&record='+timedTask.id,{headers});
  assert.match((await timedPage.text()).replaceAll('<!-- -->',''),/01:30 America\/New_York \(later\)/);

  const dealLinkPath='/?kind=tasks&workspaceId='+workspaceId+'&dealId='+deal.id;
  for(const [kind,recordKey,target,expected] of [['companies','companyId',company,restoredCompanyTask],['deals','dealId',deal,task]]){
    const filter='&kind=tasks&'+recordKey+'='+target.id;
    assert.deepEqual((await (await records(other,filter)).json()).records,[expected]);
    const privateList=await request('/api/crm?'+filter.slice(1),{headers:other});
    assert.deepEqual((await privateList.json()).records,[]);
    const detailPage=await request('/'+scoped+'&kind='+kind+'&record='+target.id,{headers:other});
    assert.equal(detailPage.status,200);
    const linkedPath=(await detailPage.text()).match(/href="([^"]+)">Linked tasks<\/a>/)?.[1].replaceAll('&amp;','&');
    const linkedURL=new URL(linkedPath,origin);
    assert.equal(linkedURL.searchParams.get(recordKey),target.id);
    assert.equal(linkedURL.searchParams.get('workspaceId'),workspaceId);
    const linkedPage=await request(linkedPath,{headers:other});
    assert.equal(linkedPage.status,200);
    assert.ok((await linkedPage.text()).includes(expected.data.name));
  }
  assert.equal((await request(dealLinkPath+'&record='+companyTask.id,{headers:other})).status,404);
  const latestReceipt=await sql`SELECT previous,data FROM portable_task_events
    WHERE task_id=${dealTask.id} AND revision=${dealTask.revision}`;
  assert.deepEqual([latestReceipt[0].previous.contactId,latestReceipt[0].data.contactId,latestReceipt[0].data.dealId],
    [replacementContact,null,deal.id]);
  assert.equal((await request(history,{headers:other})).status,404);
  assert.equal((await request(history,{headers:{}})).status,401);
  assert.equal((await request(history+'&afterId='+task.id,{headers})).status,400);
  const badTime=new URLSearchParams({afterAt:'2026-11-08T12:30:00.000+24:00',afterId:task.id,afterRevision:'1'});
  assert.equal((await request(history+'&'+badTime,{headers})).status,400);

  const sharedHistory=await (await records(other,historyQuery+'&limit=1')).json();
  const [newest]=sharedHistory.items;
  assert.equal(newest.id,task.id);
  assert.equal(newest.revision,recompletedTask.revision);
  assert.equal(newest.name,taskData.name);
  assert.equal(newest.occurredAt,recompletedTask.completedAt);
  assert.ok(newest.actorName);
  const olderQuery=new URLSearchParams({afterAt:sharedHistory.next.at,afterId:sharedHistory.next.id,
    afterRevision:String(sharedHistory.next.revision)});
  const older=await (await records(other,historyQuery+'&limit=1&'+olderQuery)).json();
  assert.deepEqual(older,{items:reopenedHistory.items,next:null});
  const taskHistory={items:[newest,...older.items],next:null};
  assert.deepEqual(await (await request(history,{headers})).json(),taskHistory);
  assert.deepEqual(await (await records(other,'&kind=tasks&completionHistoryFor='+replacementContact)).json(),{items:[],next:null});
  assert.deepEqual(await (await request(outreach,{headers})).json(),beforeTaskOutreach);
  const historyContactPage=await request('/'+scoped+'&contact='+record.id,{headers:other});
  assert.equal(historyContactPage.status,200);
  assert.match(await historyContactPage.text(),/<section[^>]*aria-label="Task completion history"/);
  assert.equal((await request('/api/record-attachments?recordId='+record.id,{headers:other})).status,404);
  assert.equal((await request('/api/background-jobs?recordId='+record.id,{headers:other})).status,404);
  const demoted=await change(headers,{action:'role',id:editor.id,role:'viewer'});
  assert.equal(demoted.status,200);
  const [demotedGrant]=(await demoted.json()).viewers;
  assert.equal((await write(editor.id,'deals',{data:{name:'Demoted write rejected'}})).status,403);
  assert.equal((await write(demotedGrant.id,'deals',{data:{name:'Viewer write rejected'}})).status,403);
  const reopenTask={id:task.id,expectedRevision:task.revision,data:{...task.data,status:'Not started'}};
  assert.equal((await write(editor.id,'tasks',reopenTask)).status,403);
  assert.equal((await write(demotedGrant.id,'tasks',reopenTask)).status,403);
  assert.equal((await ownerTask({data:taskData,assigneeId:identity.id})).status,409);
  assert.equal((await (await records(other,taskQuery)).json()).data.status,'Completed');
  const viewerTaskPage=await request('/'+scoped+'&kind=tasks&record='+task.id,{headers:other});
  assert.equal(viewerTaskPage.status,200);
  const viewerTaskHtml=await viewerTaskPage.text();
  assert.match(viewerTaskHtml.replaceAll('<!-- -->',''),/Shared workspace · View only/);
  assert.match(viewerTaskHtml,/<section[^>]*aria-label="Task details"/);
  assert.match(viewerTaskHtml,/Renamed after completion/);
  assert.doesNotMatch(viewerTaskHtml,/<button[^>]*>(?:Add task|Reopen task|Mark complete)/);
  await verifyPortableTaskDateViews({request,origin,headers,other,workspaceId,contactId:replacementContact,ownerId:ownerIdentity.id,ownerTask,sql});
  const newEditor=await change(headers,{action:'role',id:demotedGrant.id,role:'editor'});
  assert.equal(newEditor.status,200);
  const [racingGrant]=(await newEditor.json()).viewers;
  const mineOwner=await ownerTask({data:{...taskData,name:'Owner personal follow-up'},assigneeId:ownerIdentity.id});
  assert.equal(mineOwner.status,201);
  const {record:ownerFollowup}=await mineOwner.json();
  assert.deepEqual(await (await request(privateMine,{headers})).json(),{records:[ownerFollowup],next:null});
  const mineExtra=[];
  for(const name of ['Editor first follow-up','Editor second follow-up']){
    const response=await ownerTask({data:{...taskData,name},assigneeId:identity.id});
    assert.equal(response.status,201);
    mineExtra.push((await response.json()).record);
  }
  mineExtra.sort((left,right)=>left.id.localeCompare(right.id));
  const unavailablePath='/?kind=tasks&taskView=unavailable-assignee';
  const unavailable=(auth,filters={})=>request('/api/crm?'+new URLSearchParams({
    kind:'tasks',taskView:'unavailable-assignee',...filters,
  }),{headers:auth});
  const unavailablePage=async(auth,filters)=>{
    const response=await unavailable(auth,filters);
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const emptyTasks={records:[],next:null};
  assert.deepEqual(await unavailablePage(headers),emptyTasks);
  const firstMine=await mine('&limit=1');
  assert.deepEqual(firstMine,{records:[mineExtra[0]],next:mineExtra[0].id});
  assert.deepEqual(await mine('&limit=1&after='+firstMine.next),{records:[mineExtra[1]],next:null});
  let racingWrite;
  await sql.begin(async tx=>{
    await tx`UPDATE portable_workspace_viewers SET role='viewer' WHERE id=${racingGrant.id}`;
    racingWrite=write(racingGrant.id,'deals',{data:{name:'Racing write rejected'}});
    let waiting=false;
    for(let i=0;i<40&&!waiting;i++){
      const [row]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND query LIKE '%portable_workspace_viewers%' AND query LIKE '%for share%') AS waiting`;
      waiting=row.waiting;
      if(!waiting)await delay(30);
    }
    assert.ok(waiting,'Shared edit should wait for the role change to commit');
  });
  assert.equal((await racingWrite).status,403);
  assert.deepEqual(await mine(),{records:mineExtra,next:null});
  const viewerMinePage=await request('/'+scoped+mineQuery,{headers:other});
  assert.equal(viewerMinePage.status,200);
  assert.match(await viewerMinePage.text(),/<a [^>]+>Editor first follow-up<\/a>/);
  assert.equal((await sql`SELECT count(*)::int AS count FROM deals WHERE data->>'name'='Racing write rejected'`)[0].count,0);
  const [firstMissing,secondMissing]=mineExtra;
  const unavailableFirst=await unavailablePage(headers,{limit:'1'});
  assert.deepEqual(unavailableFirst,{records:[firstMissing],next:firstMissing.id});
  assert.deepEqual(await unavailablePage(headers,{limit:'1',after:unavailableFirst.next}),{records:[secondMissing],next:null});
  assert.deepEqual(await unavailablePage(headers,{search:secondMissing.data.name}),{records:[secondMissing],next:null});
  assert.deepEqual(await unavailablePage(other,{workspaceId}),{records:mineExtra,next:null});
  assert.deepEqual(await unavailablePage(other),emptyTasks);
  assert.equal((await unavailable(headers,{id:firstMissing.id})).status,400);
  assert.equal((await unavailable(other,{workspaceId,export:'csv'})).status,403);
  const csv=await unavailable(headers,{export:'csv'});
  assert.equal(csv.status,200);
  assert.equal(csv.headers.get('content-type'),'text/csv; charset=utf-8');
  assert.deepEqual((await csv.text()).trimEnd().split('\r\n').slice(1).map(row=>row.split(',')[0]),
    mineExtra.map(item=>'"'+item.id+'"'));
  const missingPath=unavailablePath+'&record='+firstMissing.id;
  const details=await request(missingPath,{headers});
  assert.equal(details.status,200);
  const detailsHtml=(await details.text()).replaceAll('<!-- -->','');
  assert.match(detailsHtml,/aria-current="page">Unavailable assignees<\/a>/);
  assert.ok(firstMissing.assigneeLabel&&detailsHtml.includes(firstMissing.assigneeLabel+' (unavailable)'));
  for(const ineligible of [ownerFollowup,task]){
    assert.equal((await request(unavailablePath+'&record='+ineligible.id,{headers})).status,404);
  }
  assert.equal((await request(missingPath,{headers:other})).status,404);

  const finalGrant=await change(headers,{action:'role',id:racingGrant.id,role:'editor'});
  assert.equal(finalGrant.status,200);
  const [restoredEditor]=(await finalGrant.json()).viewers;
  assert.deepEqual(await unavailablePage(headers),emptyTasks);
  assert.equal((await request(missingPath,{headers})).status,404);
  assert.equal((await change(headers,{action:'revoke',id:restoredEditor.id})).status,200);
  assert.equal((await unavailable(other,{workspaceId})).status,404);
  assert.equal((await request(missingPath+'&workspaceId='+workspaceId,{headers:other})).status,404);
  assert.deepEqual(await unavailablePage(headers),{records:mineExtra,next:null});
  for(const [missing,assigneeId] of [[firstMissing,ownerIdentity.id],[secondMissing,null]]){
    const saved=await ownerTask({id:missing.id,expectedRevision:missing.revision,data:missing.data,assigneeId});
    assert.equal(saved.status,200);
    assert.equal((await saved.json()).record.assigneeId,assigneeId);
    assert.equal((await request(unavailablePath+'&record='+missing.id,{headers})).status,404);
  }
  assert.deepEqual(await unavailablePage(headers),emptyTasks);
  const regranted=await change(headers,grant);
  assert.equal(regranted.status,200);
  const [regrantedViewer]=(await regranted.json()).viewers;
  const renewedEditor=await change(headers,{action:'role',id:regrantedViewer.id,role:'editor'});
  assert.equal(renewedEditor.status,200);
  const [activeEditor]=(await renewedEditor.json()).viewers;
  const grantId=fixture?await verifyPortableSharedFiles({request,origin,headers,other,record,workspaceId,change,activeEditor,sql}):activeEditor.id;
  return {workspaceId,grantId,edits,task,companyTask:restoredCompanyTask,taskHistory};
}


async function verifyPortableTaskDateViews({request,origin,headers,other,workspaceId,contactId,ownerId,ownerTask,sql}){
  const now=new Date(),hour=3_600_000;
  // These fixed-offset pairs always share a calendar day and stay far from
  // the next midnight for the duration of the fixture.
  const westOffset=[6,0,-6,6][Math.floor(now.getUTCHours()/6)],eastOffset=westOffset+6;
  const zone=offset=>offset===0?'UTC':'Etc/GMT'+(offset>0?'-':'+')+Math.abs(offset);
  const west=zone(westOffset),east=zone(eastOffset);
  const day=(at,offset)=>new Date(at+offset*hour).toISOString().slice(0,10);
  const today=day(+now,eastOffset),midnight=Date.parse(today+'T00:00:00Z');
  const yesterday=day(midnight-24*hour,0),tomorrow=day(midnight+24*hour,0);
  const timed=at=>({dueDate:day(at,0),dueTime:new Date(at).toISOString().slice(11,16),dueTimeZone:'UTC'});
  const lateWest=midnight+(23-westOffset)*hour,past=+now-2*hour;
  const queueId=randomUUID(),createdIds=[];
  const create=async(name,data,{queued=true,linked=true,assigned=false}={})=>{
    const response=await ownerTask({data:{name,...data},...(queued?{queueId}:{}),...(linked?{contactId}:{}),
      ...(assigned?{assigneeId:ownerId}:{})});
    assert.equal(response.status,201,await response.clone().text());
    const {record}=await response.json();
    createdIds.push(record.id);
    return record.id;
  };
  const get=(path,auth)=>request(path,{headers:auth});
  const query=(taskView,taskZone,filters={})=>new URLSearchParams({
    kind:'tasks',taskView,...(taskZone?{taskZone}:{}),...filters,
  });
  const shared={workspaceId,contactId};
  const scoped=(view,taskZone=east,extra={})=>query(view,taskZone,{...shared,...extra});
  const list=async(params,auth=other)=>{
    const response=await get('/api/crm?'+params,auth);
    assert.equal(response.status,200);
    return response.json();
  };
  const expectIds=(result,expected)=>assert.deepEqual(result.records.map(task=>task.id),expected.toSorted());
  try{
    const queue=await request('/api/task-queues',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'create',id:queueId,name:'Deadline fixture queue'})});
    assert.equal(queue.status,200);
    const dateToday=await create('Calendar date task today',{dueDate:today},{assigned:true});
    const dateOld=await create('Calendar date task yesterday',{dueDate:yesterday});
    const dateFuture=await create('Calendar date task tomorrow',{dueDate:tomorrow},{assigned:true});
    const timedCross=await create('Timed task across midnight',timed(lateWest),{assigned:true});
    const timedPast=await create('Timed overdue task today',timed(past),{assigned:true});
    await create('Completed deadline task',{dueDate:today,status:'Completed'},{assigned:true});
    await create('Undated deadline fixture',{});
    const outsideQueue=await create('Today outside the queue',{dueDate:today},{queued:false});
    const outsideContact=await create('Today without the selected contact',{dueDate:today},{linked:false});

    expectIds(await list(scoped('today')),[dateToday,timedPast,outsideQueue]);
    expectIds(await list(scoped('today',west)),[dateToday,timedCross,outsideQueue,
      ...(day(past,westOffset)===today?[timedPast]:[])]);
    expectIds(await list(scoped('upcoming')),[dateFuture,timedCross]);
    expectIds(await list(scoped('upcoming',west)),[dateFuture]);
    expectIds(await list(scoped('overdue')),[dateOld,timedPast]);
    expectIds(await list(query('today',east,{queueId}),headers),[dateToday,timedPast,outsideContact]);
    const mine=(view,extra={})=>query(view,east,{contactId,taskAssignee:'me',...extra});
    expectIds(await list(mine('today',{queueId}),headers),[dateToday,timedPast]);
    expectIds(await list(mine('overdue'),headers),[timedPast]);
    expectIds(await list(scoped('today',east,{taskAssignee:'me'}),other),[]);
    const mineFirst=await list(mine('upcoming',{limit:'1'}),headers);
    const mineSecond=await list(mine('upcoming',{limit:'1',after:mineFirst.next}),headers);
    expectIds({records:[...mineFirst.records,...mineSecond.records]},[dateFuture,timedCross]);
    assert.equal(mineSecond.next,null);
    assert.equal((await list(query('today',east,{contactId}))).records.length,0);
    assert.equal((await get('/api/crm?'+scoped('today'),{})).status,401);
    await list(query('today',undefined,{contactId}),headers);

    const first=await list(scoped('upcoming',east,{limit:'1'}));
    const [earlier,later]=[dateFuture,timedCross].toSorted();
    expectIds(first,[earlier]);
    assert.equal(first.next,earlier);
    const second=await list(scoped('upcoming',east,{limit:'1',after:first.next}));
    expectIds(second,[later]);
    assert.equal(second.next,null);
    for(const bad of [query('today','Invalid/Zone'),query('mine',east),query('today',east,{status:'Completed'}),
      query('mine',undefined,{taskAssignee:'me'}),query('today',east,{taskAssignee:ownerId}),
      query('today',east,{id:dateToday}),new URLSearchParams({kind:'tasks',taskZone:east})]){
      assert.equal((await get('/api/crm?'+bad,headers)).status,400);
    }

    const page=await get('/?'+scoped('today'),other);
    assert.equal(page.status,200);
    const html=await page.text();
    const current=html.match(/href="([^"]+)" aria-current="page">Due today<\/a>/)?.[1];
    const link=html.match(/href="([^"]+)">Calendar date task today<\/a>/)?.[1];
    assert.ok(current&&link);
    for(const href of [current,link]){
      const params=new URL(href.replaceAll('&amp;','&'),origin).searchParams;
      assert.deepEqual(['taskView','taskZone','workspaceId','contactId'].map(key=>params.get(key)),
        ['today',east,workspaceId,contactId]);
    }
    assert.equal(new URL(link.replaceAll('&amp;','&'),origin).searchParams.get('record'),dateToday);
    assert.match(html,/View only/);
    assert.doesNotMatch(html,/<a [^>]*>Timed task across midnight<\/a>/);
    const assignedPage=await get('/?'+mine('today'),headers);
    assert.equal(assignedPage.status,200);
    const assignedHtml=await assignedPage.text();
    assert.match(assignedHtml,/Task assignee filter[\s\S]*<option value="me" selected="">Assigned to me<\/option>/);
    const assignedLink=assignedHtml.match(/href="([^"]+)">Calendar date task today<\/a>/)?.[1];
    assert.ok(assignedLink);
    assert.equal(new URL(assignedLink.replaceAll('&amp;','&'),origin).searchParams.get('taskAssignee'),'me');
    assert.equal((await get('/?'+mine('today',{record:outsideQueue}),headers)).status,404);
  }finally{
    await sql.begin(async tx=>{
      await tx`DELETE FROM portable_task_events WHERE workspace_id=${workspaceId} AND task_id=ANY(${createdIds}::uuid[])`;
      await tx`DELETE FROM portable_tasks WHERE workspace_id=${workspaceId} AND id=ANY(${createdIds}::uuid[])`;
      await tx`DELETE FROM portable_task_queues WHERE workspace_id=${workspaceId} AND id=${queueId}`;
    });
  }
}
