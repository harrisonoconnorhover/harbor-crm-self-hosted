import {verifyRecordOwnerHandoffs} from './portable-record-owner-permissions-fixture.mjs';
import {verifyMemberToolPermissions} from './portable-member-tool-permission-fixture.mjs';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CreateBucketCommand} from '@aws-sdk/client-s3';

export async function verifyPortableRecordScopes({request,origin,headers,other,signIn,sql,fixture,env,command,cwd}){
  await signIn('invitee@example.test');
  const get=(path,auth=other)=>request(path,{headers:auth});
  const post=(path,auth,body)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const read=async(pending,status=200)=>{
    const response=await pending;
    assert.equal(response.status,status,await response.clone().text());
    return response.json();
  };
  const change=(body,auth=headers)=>read(post('/api/workspaces',auth,body));
  const repEmail='other@example.test',peerEmail='invitee@example.test';
  const workspaceId=(await read(get('/api/workspaces',headers))).owned;
  const ids=Object.fromEntries((await sql`SELECT email,id FROM login_identities`).map(row=>[row.email,row.id]));
  const repId=ids[repEmail],peerId=ids[peerEmail];
  const member=(directory,email)=>directory.viewers.find(row=>row.email===email);
  const sales=crypto.randomUUID(),pod=crypto.randomUUID(),support=crypto.randomUUID();
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  await reset();
  for(const [id,name,parentId] of [[sales,'Scope Sales',null],[pod,'Scope Pod',sales],[support,'Scope Support',null]]){
    await change({action:'team_create',id,name,parentId});
  }
  const invited=await change({action:'invite',email:repEmail,role:'editor',viewScope:'team',editScope:'owned'});
  const invitation=invited.sent.find(row=>row.email===repEmail);
  assert.match(await (await get('/?invitation='+invitation.id)).text(),/Their team and child teams/);
  await change({action:'accept_invite',id:invitation.id},other);
  let rep=member(await change({action:'grant',email:peerEmail}),repEmail);
  assert.deepEqual([rep.viewScope,rep.editScope],['team','owned']);
  let peer=member(await read(get('/api/workspaces',headers)),peerEmail);
  peer=member(await change({action:'role',id:peer.id,role:'editor'}),peerEmail);
  const assign=(id,teamId,previousTeamId=null)=>change({action:'team_assign',id,teamId,previousTeamId});
  await assign(rep.id,sales);
  await assign(peer.id,pod);
  const fileLibrary='/?view=files&workspaceId='+workspaceId;
  assert.equal((await get(fileLibrary)).status,404);
  rep=member(await change({action:'contact_files',id:rep.id,enabled:true}),repEmail);
  const api='/api/crm',scope='workspaceId='+workspaceId;
  const shared=()=>api+'?'+scope+'&grantId='+rep.id;
  const one=(kind,id)=>api+'?'+new URLSearchParams({workspaceId,kind,id});
  const make=(kind,name,assigneeId,links={})=>read(post(api,headers,{action:'save',kind,data:{name},assigneeId,...links}),201).then(body=>body.record);
  const save=(record,kind,changes={},url=shared())=>post(url,other,{action:'save',kind,id:record.id,expectedRevision:record.revision,data:{name:record.data.name},...changes});
  const check=(kind,recordId,auth=headers,memberId=rep.id)=>post('/api/workspaces',auth,{action:'check_member_record',kind,recordId,memberId});
  let company,contact;
  const visibleTaskIds=[];
  const all={};
  for(const kind of ['companies','contacts','deals','tasks']){
    const hidden=await make(kind,'Scope private '+kind,ids['owner@example.test']);
    const empty=await make(kind,'Scope unassigned '+kind,null);
    const links=kind==='contacts'?{primaryCompanyId:company.id}:kind==='deals'?{companyId:company.id,primaryContactId:contact.id}:kind==='tasks'?{related:{kind:'deals',id:all.deals.hidden.id}}:{};
    const mine=await make(kind,'Scope mine '+kind,repId,links);
    const theirs=await make(kind,'Scope peer '+kind,peerId);
    if(kind==='companies')company=hidden;
    if(kind==='contacts')contact=hidden;
    const visible=await read(get(one(kind,mine.id)));
    if(kind==='contacts')assert.deepEqual([visible.primaryCompanyId,visible.primaryCompanyName],[null,null]);
    if(kind==='deals')assert.deepEqual([visible.companyId,visible.primaryContactId],[null,null]);
    const url=api+'?'+new URLSearchParams({workspaceId,kind,search:'Scope',limit:1});
    const first=await read(get(url));
    assert.ok(first.next);
    const last=await read(get(url+'&after='+encodeURIComponent(first.next)));
    assert.deepEqual([...first.records,...last.records].map(row=>row.id).sort(),[mine.id,theirs.id].sort());
    assert.equal(last.next,null);
    for(const row of [hidden,empty])assert.equal((await get(one(kind,row.id))).status,404);
    const results=await read(post('/api/crm/search?'+scope,other,{kind,query:'Scope'}));
    assert.deepEqual(results.results.map(row=>row.id).sort(),[mine.id,theirs.id].sort());
    assert.equal((await save(theirs,kind)).status,404);
    assert.equal((await save(mine,kind,{assigneeId:peerId})).status,409);
    const edited=(await read(save(mine,kind))).record;
    assert.equal(edited.revision,mine.revision+1);
    if(kind==='tasks'){
      assert.equal(edited.dealId,null);
      assert.equal(edited.dealName,null);
      assert.equal((await read(get(one(kind,theirs.id)))).editable,false);
      assert.equal((await read(get(api+'?kind=tasks&id='+mine.id,headers))).dealId,all.deals.hidden.id);
      assert.equal((await save(edited,'tasks',{related:{kind:'deals',id:all.deals.hidden.id}})).status,404);
      const created=await read(post(shared(),other,{action:'save',kind:'tasks',data:{name:'New follow-up'}}),201);
      assert.equal(created.record.assigneeId,repId);
      const linkedMine=await make('tasks','Follow up on proposal',repId,{related:{kind:'deals',id:all.deals.mine.id}});
      const linkedHidden=await make('tasks','Owner review',ids['owner@example.test'],{related:{kind:'deals',id:all.deals.mine.id}});
      const finish=row=>({data:{name:row.data.name,status:'Completed'}});
      await read(save(linkedMine,'tasks',finish(linkedMine)));
      await read(post(api,headers,{kind:'tasks',action:'save',id:linkedHidden.id,expectedRevision:1,...finish(linkedHidden)}));
      const historyUrl=api+'?kind=tasks&recordKind=deals&'+scope+'&completionHistoryFor=';
      const history=await read(get(historyUrl+all.deals.mine.id));
      assert.deepEqual(history.items.map(item=>item.id),[linkedMine.id]);
      assert.equal((await get(historyUrl+all.deals.hidden.id)).status,404);
      const reminder=await read(post(shared(),other,{action:'save',kind:'tasks',data:{name:'Assigned reminder',
        dueDate:'2023-08-01',dueTime:'08:00',dueTimeZone:'UTC',reminderMinutes:15}}),201);
      const inbox='/api/task-reminders?'+scope;
      assert.ok((await read(get(inbox))).items.some(item=>item.id===reminder.record.id));
      await read(post(inbox,other,{id:reminder.record.id,expectedRevision:1}));
      assert.ok(!(await read(get(inbox))).items.some(item=>item.id===reminder.record.id));
      visibleTaskIds.push(mine.id,theirs.id,created.record.id,linkedMine.id,reminder.record.id);
    }else{
      all[kind]={mine:edited,theirs,hidden};
      assert.deepEqual(await read(check(kind,mine.id)),{canView:true,canEdit:true});
      assert.deepEqual(await read(check(kind,theirs.id)),{canView:true,canEdit:false});
      assert.deepEqual(await read(check(kind,hidden.id)),{canView:false,canEdit:false});
    }
  }
  await reset();
  assert.equal((await check('deals',all.deals.mine.id,other)).status,404);
  assert.equal((await check('deals',crypto.randomUUID())).status,404);
  await verifyMemberPreview({origin,headers,memberId:rep.id,deal:all.deals.theirs});
  const ownCreate=await read(post(shared(),other,{action:'save',kind:'contacts',data:{name:'Scoped self-assignment'}}),201);
  assert.equal(ownCreate.record.data.recordOwner.userId,repId);
  const views='/api/crm/views';
  const createView=name=>read(post(views,headers,{action:'create',kind:'contacts',name,filters:{search:'Scope'}}),201).then(body=>body.view);
  const sharedView=await createView('Team follow-up');
  const privateView=await createView('Private follow-up');
  await read(post(views,headers,{action:'setSharing',kind:'contacts',id:sharedView.id,expectedRevision:sharedView.revision,shared:true}));
  const viewUrl=id=>'/?kind=contacts&savedView='+id+'&'+scope;
  const opened=await get(viewUrl(sharedView.id));
  assert.equal(opened.status,200);
  const viewHtml=await opened.text();
  assert.match(viewHtml,/Scope peer contacts/);
  assert.doesNotMatch(viewHtml,/Scope private contacts|Scope unassigned contacts/);
  assert.equal((await get(viewUrl(privateView.id))).status,404);
  const tickets='/api/tickets';
  const ticketWrite=()=>tickets+'?'+scope+'&grantId='+rep.id;
  const ticketUrl=id=>tickets+'?id='+id+'&'+scope;
  const createTicket=async(name,assigneeId,links={})=>(await read(post(tickets,headers,{action:'save',assigneeId,data:{name:'Access trial '+name,owner:repEmail},...links}),201)).record;
  const myTicket=await createTicket('mine',repId,{contactId:contact.id,companyId:company.id});
  const peerTicket=await createTicket('peer',peerId);
  const legacyTicket=await createTicket('legacy',undefined);
  const theirTicket=await createTicket('private',ids['owner@example.test']);
  const direct=await read(get(ticketUrl(myTicket.id)));
  assert.equal(direct.editable,true);
  assert.deepEqual([direct.contactId,direct.contactName,direct.companyId,direct.companyName],[null,null,null,null]);
  for(const hidden of [legacyTicket,theirTicket])assert.equal((await get(ticketUrl(hidden.id))).status,404);
  const statusChange=row=>({action:'status',id:row.id,expectedRevision:row.revision,status:'Waiting on us'});
  assert.equal((await read(get(ticketUrl(peerTicket.id)))).editable,false);
  assert.equal((await post(ticketWrite(),other,statusChange(peerTicket))).status,404);
  const mineUpdated=await read(post(ticketWrite(),other,statusChange(myTicket)));
  assert.equal(mineUpdated.record.assigneeId,repId);
  assert.equal(mineUpdated.record.companyId,null);
  assert.equal((await read(get(tickets+'?id='+myTicket.id,headers))).companyId,company.id);
  assert.equal((await post(ticketWrite(),other,{action:'save',data:{name:'Cannot assign outside scope'},assigneeId:peerId})).status,400);
  assert.equal((await post(ticketWrite(),other,{action:'save',data:{name:'Cannot link hidden contact'},contactId:contact.id})).status,404);
  const selfTicket=(await read(post(ticketWrite(),other,{action:'save',data:{name:'Access trial self-created'}}),201)).record;
  assert.equal(selfTicket.assigneeId,repId);
  const ticketIds=[myTicket.id,peerTicket.id,selfTicket.id].sort();
  const foundTickets=await read(post('/api/crm/search?'+scope,other,{kind:'tickets',query:'Access trial'}));
  assert.deepEqual(foundTickets.results.map(item=>item.id).sort(),ticketIds);
  const ticketList=tickets+'?'+scope+'&search=Access+trial&limit=2';
  const firstTickets=await read(get(ticketList));
  const lastTickets=await read(get(ticketList+'&after='+firstTickets.next));
  assert.deepEqual([...firstTickets.records,...lastTickets.records].map(item=>item.id),ticketIds);
  assert.equal(lastTickets.next,null);
  const ticketPage='/tickets?'+scope+'&id=';
  assert.equal((await get(ticketPage+myTicket.id)).status,200);
  assert.doesNotMatch(await (await get(ticketPage+peerTicket.id)).text(),/>Edit ticket</);
  assert.equal((await get(ticketPage+theirTicket.id)).status,404);
  await verifyTicketAssignmentPicker({origin,headers,other,workspaceId,id:legacyTicket.id,repId});
  const reporting='/api/reporting';
  const report=async(kind,name,groupBy)=>(await read(post(reporting,headers,{action:'report',definition:{kind,name,groupBy}}),201)).item;
  const contactReport=await report('contacts','Contacts in scope','recordOwner');
  const tasksReport=await report('tasks','Team tasks');
  const ticketsReport=await report('tickets','Team tickets');
  const definition={name:'Scope dashboard',cards:[contactReport,tasksReport,ticketsReport].map(row=>({reportId:row.id,wide:false}))};
  const dashboard=(await read(post(reporting,headers,{action:'dashboard',definition}),201)).item;
  const detail=reporting+'?view=dashboard&id='+dashboard.id+'&'+scope;
  const drill=reporting+'?view=dashboardRecords&id='+dashboard.id+'&'+scope+'&reportId=';
  assert.equal((await get(detail)).status,404);
  await read(post(reporting,headers,{action:'dashboard',id:dashboard.id,revision:dashboard.revision,definition,teamVisible:true}));
  const totals=await read(get(detail));
  assert.equal(totals.cards[0].result.count,'3');
  assert.deepEqual(Object.fromEntries(totals.cards[0].result.rows.map(row=>[row.key,row.count])),{[repId]:'2',[peerId]:'1'});
  const peerGroup=drill+contactReport.id+'&group='+encodeURIComponent(peerId);
  assert.deepEqual((await read(get(peerGroup))).records.map(item=>item.id),[all.contacts.theirs.id]);
  assert.equal(totals.cards[1].result.count,String(visibleTaskIds.length));
  assert.deepEqual((await read(get(drill+tasksReport.id))).records.map(row=>row.id).sort(),visibleTaskIds.sort());
  assert.equal(totals.cards[2].result.count,String(ticketIds.length));
  assert.deepEqual((await read(get(drill+ticketsReport.id))).records.map(item=>item.id).sort(),ticketIds);
  const dashboardScreen=await get('/?view=dashboards&dashboardId='+dashboard.id+'&'+scope);
  assert.equal(dashboardScreen.status,200);
  assert.match(await dashboardScreen.text(),/Contacts in scope/);
  const drillIds=async()=>(await read(get(drill+contactReport.id))).records.map(row=>row.id).sort();
  const ownContactIds=[all.contacts.mine.id,ownCreate.record.id].sort();
  assert.deepEqual(await drillIds(),[...ownContactIds,all.contacts.theirs.id].sort());
  const peerContact=all.contacts.theirs;
  const association='/api/associations?kind=contacts&id='+peerContact.id;
  for(const record of [all.companies.mine,all.companies.hidden]){
    await read(post(association,headers,{action:'link',target:{kind:'companies',id:record.id},labels:[]}));
  }
  const linked=await read(get(association+'&'+scope));
  assert.deepEqual(linked.items.map(row=>row.target.id),[all.companies.mine.id]);
  const repLinks=(kind,id)=>'/api/associations?'+new URLSearchParams({kind,id,workspaceId});
  const dealLinks=repLinks('deals',all.deals.mine.id);
  const editLink=(path,body)=>post(path+'&grantId='+rep.id,other,body);
  const toContact=id=>({action:'link',target:{kind:'contacts',id},labels:['Buying contact']});
  const picker='/api/crm?kind=contacts&owner=editable&search=Scope&'+scope;
  assert.deepEqual((await read(get(picker))).records.map(row=>row.id).sort(),ownContactIds);
  for(const record of [peerContact,all.contacts.hidden]){
    assert.equal((await editLink(dealLinks,toContact(record.id))).status,404);
  }
  const reverse=repLinks('companies',all.companies.mine.id);
  const readOnlyLink=(await read(get(reverse))).items.find(item=>item.target.id===peerContact.id);
  assert.equal(readOnlyLink.readOnly,true);
  assert.equal((await editLink(reverse,{action:'unlink',linkId:readOnlyLink.id})).status,404);
  assert.equal((await editLink(reverse,{action:'relabel',linkId:readOnlyLink.id,expectedLabels:readOnlyLink.labels,labels:['Buyer']})).status,404);
  assert.equal((await editLink(association+'&'+scope,{action:'relabel',linkId:readOnlyLink.id,expectedLabels:readOnlyLink.labels,labels:['Buyer']})).status,404);
  assert.equal((await editLink(association+'&'+scope,{action:'unlink',linkId:readOnlyLink.id})).status,404);
  await reset();
  // The outgoing endpoint matters too: a rep cannot displace a hidden primary link.
  for(const [kind,field,target] of [['contacts','primaryCompanyId',all.companies],['deals','companyId',all.companies],['deals','primaryContactId',all.contacts]]){
    const source=all[kind].mine;
    for(const value of [null,target.mine.id]){
      assert.equal((await save(source,kind,{[field]:value})).status,404);
    }
    const stored=await read(get(api+'?kind='+kind+'&id='+source.id,headers));
    assert.equal(stored[field],target.hidden.id);
    assert.equal(stored.revision,source.revision);
  }
  const primary=ownCreate.record;
  assert.equal((await save(primary,'contacts',{primaryCompanyId:all.companies.theirs.id})).status,404);
  const assigned=(await read(save(primary,'contacts',{primaryCompanyId:all.companies.mine.id}))).record;
  assert.equal(assigned.primaryCompanyId,all.companies.mine.id);
  assert.equal((await save(primary,'contacts',{primaryCompanyId:null})).status,409);
  assert.equal((await read(save(assigned,'contacts',{primaryCompanyId:null}))).record.primaryCompanyId,null);
  const prepared=(await read(post(api,headers,{action:'save',kind:'deals',id:all.deals.mine.id,
    expectedRevision:all.deals.mine.revision,data:{name:all.deals.mine.data.name},companyId:null,primaryContactId:null}))).record;
  const notesPath=id=>'/api/background-jobs?recordId='+id;
  const sharedNotes=id=>notesPath(id)+'&'+scope;
  const schedule=(id,body)=>post(sharedNotes(id)+'&grantId='+rep.id,other,body);
  const teamNote={id:crypto.randomUUID(),body:'Prepare renewal handover',scheduledFor:Date.now()};
  const ownerNote={id:crypto.randomUUID(),body:'Review renewal with the account team',scheduledFor:Date.now()+86400000};
  await read(post(notesPath(peerContact.id),headers,ownerNote),202);
  assert.equal((await get(sharedNotes(all.contacts.mine.id))).status,404);
  assert.equal((await schedule(all.contacts.mine.id,teamNote)).status,404);
  rep=member(await change({action:'scheduled_notes',id:rep.id,enabled:true}),repEmail);
  assert.equal((await get(sharedNotes(all.contacts.hidden.id))).status,404);
  assert.equal((await schedule(peerContact.id,teamNote)).status,404);
  await reset();
  await checkAssociationEditor({origin,other,workspaceId,deal:prepared,contact:all.contacts.mine,peerContact,company:all.companies.mine});
  const savedDeal=await read(get(one('deals',prepared.id)));
  assert.deepEqual([savedDeal.companyId,savedDeal.primaryContactId],[all.companies.mine.id,all.contacts.mine.id]);
  assert.equal((await save(savedDeal,'deals',{primaryContactId:peerContact.id})).status,404);
  const {pipeline}=await read(post('/api/pipeline',headers,{name:'Scope renewals',stages:[
    {name:'Working',outcome:'open'},{name:'Accepted',outcome:'won'},{name:'Passed',outcome:'lost'},
  ]}),201);
  const custom=await make('deals','Renewal in pod',peerId,{pipelineId:pipeline.id,stageId:pipeline.stages[0].id});
  const customBoard=await get('/?kind=deals&view=board&pipelineId='+pipeline.id+'&'+scope);
  assert.equal(customBoard.status,200);
  assert.match(await customBoard.text(),new RegExp(custom.data.name));
  const board=await get('/?kind=deals&view=board&'+scope);
  assert.equal(board.status,200);
  const boardHtml=await board.text();
  assert.match(boardHtml,/Scope peer deals/);
  assert.doesNotMatch(boardHtml,/aria-label="Move Scope peer deals to stage"/);
  assert.match(boardHtml,/aria-label="Move Scope mine deals to stage"/);
  assert.doesNotMatch(boardHtml,/Scope private deals|Scope unassigned deals/);
  assert.equal((await get(api+'?kind=deals&export=csv&'+scope)).status,403);
  const savedPage='/?contact='+peerContact.id+'&'+scope;
  assert.match(await (await get(savedPage)).text(),/Scope peer contacts/);
  const file='/api/record-attachments?recordId='+peerContact.id+'&fileId='+crypto.randomUUID();
  const bytes='Fictional scope fixture';
  await fixture.storage.send(new CreateBucketCommand({Bucket:fixture.bucket}));
  assert.equal((await request(file+'&versionId='+crypto.randomUUID(),{method:'POST',headers:{...headers,origin,'x-harbor-file-name':'scope.txt'},body:bytes})).status,200);
  assert.equal(await (await get(file+'&'+scope)).text(),bytes);
  const nextFilesPage=await checkSharedFiles({origin,other,sql,workspaceId,peerContact,hidden:all.contacts.hidden.id,fileLibrary,bytes});
  assert.equal((await get(fileLibrary+'&contactId='+all.contacts.hidden.id)).status,404);
  assert.equal((await get(fileLibrary+'&folder=root')).status,404);
  await reset();
  const attempt=await request('/api/record-attachments?'+new URLSearchParams({workspaceId,grantId:rep.id,recordId:peerContact.id,fileId:crypto.randomUUID(),versionId:crypto.randomUUID()}),{
    method:'POST',headers:{...other,origin,'x-harbor-file-name':'scope.txt'},body:bytes});
  assert.ok([403,404].includes(attempt.status),'Viewing team files does not allow uploading to a peer contact.');
  const timeline=(kind,id)=>'/api/logged-activities?'+new URLSearchParams(kind==='contacts'?{contactId:id}:{kind,recordId:id});
  const log=(label)=>({id:crypto.randomUUID(),kind:'Call',occurredAt:Date.now()-60000,summary:label});
  const entries={};
  for(const kind of ['contacts','companies','deals']){
    await reset();
    const {mine,theirs,hidden}=all[kind],flag=kind==='contacts'?'contact_outreach':'record_activities';
    const ownPath=timeline(kind,mine.id)+'&'+scope,peerPath=timeline(kind,theirs.id)+'&'+scope;
    if(kind!=='deals'){
      assert.equal((await get(ownPath)).status,404);
      rep=member(await change({action:flag,id:rep.id,enabled:true}),repEmail);
    }
    const write=path=>path+'&grantId='+rep.id;
    const entry=log('Fictional scoped call '+kind);
    await read(post(write(ownPath),other,entry),201);
    const revised={action:'update',id:entry.id,expectedRevision:1,occurredAt:entry.occurredAt,summary:'Follow-up booked'};
    await read(post(write(ownPath),other,revised));
    assert.equal((await read(get(ownPath))).lastContacted,entry.occurredAt);
    assert.equal((await read(get(ownPath+'&history='+entry.id))).items[0].previousSummary,entry.summary);
    const peerEntry=log('Peer follow-up');
    await read(post(timeline(kind,theirs.id),headers,peerEntry),201);
    assert.equal((await read(get(peerPath))).items[0].id,peerEntry.id);
    assert.equal((await post(write(peerPath),other,log('Outside edit scope'))).status,404);
    assert.equal((await post(write(peerPath),other,{action:'remove',id:peerEntry.id,expectedRevision:1})).status,404);
    assert.equal((await get(timeline(kind,hidden.id)+'&'+scope)).status,404);
    entries[kind]={path:peerPath,id:peerEntry.id};
  }
  const sortedPath=api+'?kind=contacts&sort=outreach-newest&limit=1&search=Scope&'+scope;
  const latest=await read(get(sortedPath));
  assert.equal(latest.records[0].id,all.contacts.theirs.id);
  assert.equal((await read(get(sortedPath+'&after='+encodeURIComponent(latest.next)))).records[0].id,all.contacts.mine.id);
  const outreachView=(await read(post(views,headers,{action:'create',kind:'contacts',name:'Recent team calls',
    filters:{search:'Scope',sort:'outreach-newest'},columns:['name','lastContacted']}),201)).view;
  await read(post(views,headers,{action:'setSharing',kind:'contacts',id:outreachView.id,expectedRevision:outreachView.revision,shared:true}));
  assert.match(await (await get(viewUrl(outreachView.id))).text(),/>Last contacted</);
  rep=member(await change({action:'contact_outreach',id:rep.id,enabled:false}),repEmail);
  assert.equal((await get(timeline('contacts',all.contacts.mine.id)+'&'+scope)).status,404);
  assert.doesNotMatch(await (await get(viewUrl(outreachView.id))).text(),/>Last contacted</);
  rep=member(await change({action:'contact_outreach',id:rep.id,enabled:true}),repEmail);
  const oldUrl=shared();
  rep=member(await change({action:'record_scope',id:rep.id,viewScope:'team',editScope:'team'}),repEmail);
  peer=await verifyRecordOwnerHandoffs({origin,read,get,post,change,make,scope,headers,other,rep,repId,peer,peerId,peerContactId:all.contacts.theirs.id});
  await reset();
  assert.notEqual(rep.id,new URL(oldUrl,origin).searchParams.get('grantId'));
  assert.equal((await check('contacts',peerContact.id,headers,new URL(oldUrl,origin).searchParams.get('grantId'))).status,404);
  assert.deepEqual(await read(check('contacts',peerContact.id)),{canView:true,canEdit:true});
  assert.equal((await save(peerContact,'contacts',{},oldUrl)).status,403);
  await read(schedule(peerContact.id,teamNote),202);
  await read(schedule(peerContact.id,teamNote),202);
  assert.equal((await schedule(peerContact.id,{action:'cancelNote',id:teamNote.id})).status,403);
  const peerEdit=(await read(save(peerContact,'contacts'))).record;
  const beforeMove=await read(get(one('deals',savedDeal.id)));
  const teamDeal=(await read(save(beforeMove,'deals',{primaryContactId:peerContact.id}))).record;
  assert.equal(teamDeal.primaryContactId,peerContact.id);
  await read(editLink(dealLinks,toContact(peerContact.id)));
  const teamLink=(await read(get(dealLinks))).items.find(item=>item.target.id===peerContact.id);
  assert.ok(teamLink&&!teamLink.readOnly);
  assert.ok((await read(get(picker))).records.some(row=>row.id===peerContact.id));
  for(const {path,id} of Object.values(entries)){
    await read(post(path+'&grantId='+rep.id,other,{action:'remove',id,expectedRevision:1}));
    assert.equal((await read(get(path+'&removed=1'))).items[0].id,id);
  }
  await read(post(ticketWrite(),other,statusChange(peerTicket)));
  await assign(peer.id,support,pod);
  assert.equal((await get(nextFilesPage)).status,404);
  assert.equal((await get(fileLibrary+'&contactId='+peerContact.id)).status,404);
  assert.doesNotMatch(await (await get(fileLibrary)).text(),/scope[.]txt|Team handout|Restricted handout/);
  assert.equal((await get(sharedNotes(peerContact.id))).status,404);
  assert.equal((await schedule(peerContact.id,teamNote)).status,404);
  const runNotes=()=>promisify(execFile)(process.execPath,[command,'worker','--once','--notes-only'],{env,cwd,timeout:10000});
  await runNotes();
  await runNotes();
  const receipt=(await read(get(notesPath(peerContact.id),headers))).items.find(job=>job.id===teamNote.id);
  assert.equal(receipt.status,'succeeded');
  assert.equal(receipt.actorEmail,repEmail);
  assert.equal(receipt.attempts,1);
  assert.equal(receipt.receipts.length,1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM portable_notes WHERE job_id=${teamNote.id}`)[0].n,1);

  assert.equal((await save(teamDeal,'deals',{primaryContactId:null})).status,404);
  const afterMove=await read(get(one('deals',teamDeal.id)));
  assert.equal(afterMove.primaryContactId,null);
  const retained=await read(get(api+'?kind=deals&id='+teamDeal.id,headers));
  assert.equal(retained.primaryContactId,peerContact.id);
  assert.equal(retained.revision,teamDeal.revision);
  assert.equal((await editLink(dealLinks,{action:'unlink',linkId:teamLink.id})).status,404);
  assert.ok(!(await read(get(dealLinks))).items.some(item=>item.id===teamLink.id));
  assert.ok((await read(get('/api/associations?kind=deals&id='+all.deals.mine.id,headers))).items.some(item=>item.id===teamLink.id));
  assert.equal((await get(ticketUrl(peerTicket.id))).status,404);
  assert.deepEqual((await read(get(drill+ticketsReport.id))).records.map(item=>item.id).sort(),[myTicket.id,selfTicket.id].sort());
  assert.equal((await get(one('contacts',peerContact.id))).status,404);
  assert.equal((await get(file+'&'+scope)).status,404);
  assert.equal((await get(association+'&'+scope)).status,404);
  for(const {path,id} of Object.values(entries)){
    for(const query of ['', '&removed=1','&history='+id])assert.equal((await get(path+query)).status,404);
  }
  assert.deepEqual(await drillIds(),ownContactIds);
  assert.equal((await read(get(detail))).cards[0].result.count,'2');
  assert.deepEqual((await read(get(detail))).cards[0].result.rows.map(row=>row.key),[repId]);
  assert.deepEqual((await read(get(peerGroup))).records,[]);
  const movedView=await get(viewUrl(sharedView.id));
  assert.equal(movedView.status,200);
  assert.doesNotMatch(await movedView.text(),/Scope peer contacts/);
  const stalePage=await get(savedPage);
  assert.doesNotMatch(await stalePage.text(),/Scope peer contacts/);
  assert.equal((await save(peerEdit,'contacts')).status,404);
  assert.equal((await get(one('contacts',ownCreate.record.id))).status,200);
  await assign(peer.id,pod,support);
  await assign(rep.id,null,sales);
  assert.deepEqual(await read(check('contacts',peerContact.id)),{canView:false,canEdit:false});
  assert.equal((await get(one('contacts',peerContact.id))).status,404);
  assert.equal((await get(one('contacts',ownCreate.record.id))).status,200);
  await assign(rep.id,sales,null);
  rep=member(await change({action:'record_scope',id:rep.id,viewScope:'owned',editScope:'owned'}),repEmail);
  assert.equal((await get(one('contacts',peerContact.id))).status,404);
  assert.deepEqual((await read(get(detail))).cards[0].result.rows.map(row=>row.key),[repId]);
  assert.deepEqual((await read(get(peerGroup))).records,[]);
  rep=await verifyScopedListActions({read,get,post,change,assign,reset,make,scope,rep,repId,repEmail,peer,peerId,pod,support,other,headers});
  rep=member(await change({action:'record_scope',id:rep.id,viewScope:'all',editScope:'all'}),repEmail);
  assert.equal((await get(one('contacts',all.contacts.hidden.id))).status,200);
  ({rep,peer}=await verifyMemberToolPermissions({read,get,post,change,headers,other,scope,rep,peer,all,one,check,drill,contactReport,file,make,repId,reset}));
  await change({action:'revoke',id:rep.id});
  assert.equal((await get(file+'&'+scope)).status,404);
  assert.equal((await get(one('contacts',ownCreate.record.id))).status,404);
  assert.equal((await get(viewUrl(sharedView.id))).status,404);
  assert.equal((await get(detail)).status,404);
  assert.equal((await get(drill+contactReport.id)).status,404);
  await change({action:'revoke',id:peer.id});
  for(const id of [pod,support,sales])await change({action:'team_remove',id,revision:1});
  await reset();
}

async function verifyScopedListActions({read,get,post,change,assign,reset,make,scope,rep,repId,repEmail,peer,peerId,pod,support,other,headers}){
  const write=()=>'/api/crm?'+scope+'&grantId='+rep.id;
  const recycle=()=>'/api/recycle-bin?'+scope+'&grantId='+rep.id;
  const bulk=(kind,rows,body,path=write())=>post(path,other,{kind,...body,records:rows.map(({id,revision})=>({id,expectedRevision:revision}))});
  const property=(kind,value)=>({action:'editProperty',mode:'replace',field:kind==='deals'?'amount':'city',value});
  const assignTo=assigneeId=>({action:'assignOwners',assigneeId});
  const archive=(kind,row,action='archive')=>({kind,id:row.id,expectedRevision:row.revision,requestId:crypto.randomUUID(),action});
  const owned=(kind,row)=>read(get('/api/crm?'+new URLSearchParams({kind,id:row.id}),headers));
  const kinds=['contacts','companies','deals'],rows={};
  for(const kind of kinds){
    await reset();
    const mine=await make(kind,'Batch mine '+kind,repId);
    const theirs=await make(kind,'Batch peer '+kind,peerId);
    const testValue=kind==='deals'?125:'Albany';
    assert.equal((await bulk(kind,[mine,theirs],property(kind,testValue))).status,404);
    assert.equal((await bulk(kind,[mine,theirs],assignTo(repId))).status,404);
    assert.equal((await owned(kind,mine)).revision,mine.revision);
    assert.equal((await bulk(kind,[mine],assignTo(peerId))).status,409);
    assert.equal((await bulk(kind,[mine],assignTo(null))).status,409);
    assert.equal((await read(bulk(kind,[mine],property(kind,testValue)))).changed,1);
    assert.equal((await post(recycle(),other,archive(kind,theirs))).status,404);
    rows[kind]={mine:await owned(kind,mine),theirs};
  }
  const oldWrite=write();
  rep=(await change({action:'record_scope',id:rep.id,viewScope:'team',editScope:'team'})).viewers.find(row=>row.email===repEmail);
  assert.equal((await bulk('deals',[rows.deals.mine],property('deals',12),oldWrite)).status,403);
  for(const kind of kinds){
    await reset();
    const {mine,theirs}=rows[kind];
    assert.equal((await read(bulk(kind,[mine,theirs],assignTo(peerId)))).changed,1);
    const both=await Promise.all([owned(kind,mine),owned(kind,theirs)]);
    assert.ok(both.every(row=>row.data.recordOwner.userId===peerId));
    const body=archive(kind,both[0]);
    const {receipt}=await read(post(recycle(),other,body));
    assert.deepEqual((await read(post(recycle(),other,body))).receipt,receipt);
    const bin=()=>read(get(recycle()+'&kind='+kind));
    assert.ok((await bin()).records.some(row=>row.id===mine.id));
    const restore=archive(kind,receipt,'restore');
    await assign(peer.id,support,pod);
    assert.ok(!(await bin()).records.some(row=>row.id===mine.id));
    assert.equal((await post(recycle(),other,body)).status,404);
    assert.equal((await post(recycle(),other,restore)).status,404);
    assert.equal((await bulk(kind,[both[1]],property(kind,kind==='deals'?100:'Boston'))).status,404);
    await assign(peer.id,pod,support);
    await read(post(recycle(),other,restore));
    assert.equal((await owned(kind,mine)).revision,receipt.revision+1);
  }
  for(const kind of ['tasks','leads','tickets']){
    await reset();
    async function create(assigneeId){
      const name='Scoped archive '+kind;
      if(kind==='tasks')return (await read(post('/api/crm',headers,{action:'save',kind,assigneeId,
        data:{name,dueDate:'2040-05-20',repeat:assigneeId?{every:1,unit:'days',timeZone:'UTC'}:null}}),201)).record;
      const saved=await read(post('/api/'+kind,headers,{action:'save',assigneeId,data:{name}}),201);
      return kind==='tickets'?saved.record:{id:saved.id,revision:1};
    }
    const inTeam=await create(peerId),unassigned=await create(null);
    const bin=()=>read(get(recycle()+'&kind='+kind));
    const body=archive(kind,inTeam);
    assert.equal((await post(recycle(),other,archive(kind,unassigned))).status,404);
    const {receipt:outside}=await read(post('/api/recycle-bin',headers,archive(kind,unassigned)));
    const {receipt}=await read(post(recycle(),other,body));
    assert.deepEqual((await read(post(recycle(),other,body))).receipt,receipt);
    if(kind==='tasks'){
      assert.ok(receipt.nextTaskId);
      const next=await owned(kind,{id:receipt.nextTaskId});
      await read(post('/api/crm',headers,{action:'save',kind,id:next.id,expectedRevision:next.revision,assigneeId:null,data:{name:next.data.name}}));
      const replay=await read(post(recycle(),other,body));
      assert.equal(replay.receipt.nextTaskId,undefined);
      assert.equal(replay.receipt.revision,receipt.revision);
    }
    const page=await bin();
    assert.ok(page.records.some(row=>row.id===inTeam.id));
    assert.ok(!page.records.some(row=>row.id===unassigned.id));
    assert.equal((await post(recycle(),other,archive(kind,outside,'restore'))).status,404);
    const restore=archive(kind,receipt,'restore');
    await assign(peer.id,support,pod);
    assert.ok(!(await bin()).records.some(row=>row.id===inTeam.id));
    assert.equal((await post(recycle(),other,body)).status,404);
    assert.equal((await post(recycle(),other,restore)).status,404);
    await assign(peer.id,pod,support);
    const {receipt:restored}=await read(post(recycle(),other,restore));
    assert.ok(!(await bin()).records.some(row=>row.id===inTeam.id));
    // The routing fixture that follows starts with an empty workload.
    if(kind==='leads')await read(post('/api/recycle-bin',headers,archive(kind,restored)));
  }
  return rep;
}

async function verifyTicketAssignmentPicker({origin,headers,other,workspaceId,id,repId}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  async function session(auth){
    const context=await browser.newContext();
    const [name,value]=auth.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    return context.newPage();
  }
  try{
    const owner=await session(headers),rep=await session(other);
    await owner.goto(origin+'/tickets?id='+id);
    async function assign(value){
      await owner.getByRole('button',{name:'Edit ticket',exact:true}).click();
      await owner.getByRole('combobox',{name:/^Assigned to\b/}).selectOption(value);
      const done=owner.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/tickets');
      await owner.getByRole('button',{name:'Save ticket',exact:true}).click();
      assert.ok((await done).ok());
      await owner.getByRole('button',{name:'Edit ticket',exact:true}).waitFor();
    }
    await assign(repId);
    await rep.goto(origin+'/?kind=deals&workspaceId='+workspaceId);
    const nav=rep.getByRole('navigation',{name:'Main navigation'});
    await nav.getByRole('button',{name:'Service',exact:true}).click();
    await nav.getByRole('link',{name:'Tickets',exact:true}).click();
    const ticket=rep.getByRole('link',{name:'Access trial legacy',exact:true});
    assert.equal(new URL(await ticket.getAttribute('href'),origin).searchParams.get('workspaceId'),workspaceId);
    await ticket.click();
    await rep.getByRole('button',{name:'Edit ticket',exact:true}).click();
    assert.equal(await rep.getByRole('combobox',{name:/^Assigned to\b/}).inputValue(),repId);
    await rep.getByRole('button',{name:'Cancel',exact:true}).click();
    await rep.getByRole('button',{name:'Archive ticket',exact:true}).click();
    await rep.getByRole('button',{name:'Confirm archive',exact:true}).click();
    const row=rep.getByRole('row').filter({hasText:'Access trial legacy'});
    await row.getByRole('button',{name:'Restore ticket',exact:true}).click();
    await rep.getByRole('button',{name:'Edit ticket',exact:true}).waitFor();
    await owner.reload();
    await assign('');
    assert.equal((await rep.reload()).status(),404);
  }finally{await browser.close();}
}

async function checkAssociationEditor({origin,other,workspaceId,deal,contact,peerContact,company}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const [name,value]=other.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    await page.goto(origin+'/?kind=deals&record='+deal.id+'&workspaceId='+workspaceId);
    const links=page.getByRole('navigation',{name:'Record associations'});
    await links.getByRole('button',{name:'Edit primary contact',exact:true}).click();
    await page.waitForFunction(()=>document.activeElement?.getAttribute('name')==='primaryContactId');
    const form=page.locator('form.portable-record-editor');
    await form.locator('select[name="primaryContactId"]').selectOption(contact.id);
    assert.equal(await form.locator('select[name="primaryContactId"] option[value="'+peerContact.id+'"]').count(),0);
    await form.locator('select[name="companyId"]').selectOption(company.id);
    await form.getByRole('button',{name:'Save deal',exact:true}).click();
    await links.getByRole('link',{name:company.data.name,exact:true}).waitFor();
    await page.reload();
    await links.getByRole('link',{name:contact.data.name,exact:true}).waitFor();
    const panel=page.getByRole('region',{name:'Additional associations'});
    await panel.getByText('Add association',{exact:true}).click();
    const response=page.waitForResponse(r=>{
      const url=new URL(r.url());
      return url.pathname==='/api/crm'&&url.searchParams.get('kind')==='contacts'&&url.searchParams.get('owner')==='editable';
    });
    await panel.getByLabel('Record type').selectOption('contacts');
    const candidates=await response;
    assert.ok(candidates.ok(),await candidates.text());
    const picker=panel.getByRole('combobox',{name:/^Record to link/});
    await picker.selectOption(contact.id);
    assert.equal(await picker.locator('option[value="'+peerContact.id+'"]').count(),0);
    await panel.getByRole('button',{name:'Link record',exact:true}).click();
    await panel.getByRole('link',{name:contact.data.name,exact:true}).waitFor();
    await page.reload();
    await panel.getByRole('button',{name:'Edit labels for '+contact.data.name,exact:true}).click();
    await panel.getByLabel('Label 1',{exact:true}).fill('Buying committee');
    await panel.getByRole('button',{name:'Save labels',exact:true}).click();
    await panel.getByText('Contact · Buying committee',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Remove link to '+contact.data.name,exact:true}).click();
    await panel.getByText('Association removed.',{exact:true}).waitFor();
    await panel.getByRole('link',{name:contact.data.name,exact:true}).waitFor({state:'hidden'});
    const contactPath=id=>origin+'/?'+new URLSearchParams({contact:id,workspaceId})+'#portable-contact-jobs';
    const notes=page.getByRole('region',{name:'Scheduled notes',exact:true});
    await page.goto(contactPath(peerContact.id));
    await notes.getByText('Review renewal with the account team',{exact:false}).waitFor();
    assert.equal(await notes.getByRole('button',{name:'Schedule note',exact:true}).count(),0);
    await page.goto(contactPath(contact.id));
    await notes.getByLabel('Note',{exact:true}).fill('Confirm next steps with customer');
    await notes.getByRole('button',{name:'Schedule note',exact:true}).click();
    await notes.getByText('Note queued.',{exact:true}).waitFor();
    await page.reload();
    await notes.getByText('Confirm next steps with customer',{exact:false}).waitFor();
  }finally{await browser.close();}
}


async function checkSharedFiles({origin,other,sql,workspaceId,peerContact,hidden,fileLibrary,bytes}){
  const folderId=crypto.randomUUID();
  await sql`INSERT INTO portable_file_folders(workspace_id,id,name,name_key)
    VALUES(${workspaceId},${folderId},'Private filing cabinet','private filing cabinet')`;
  await sql`INSERT INTO portable_file_locations(workspace_id,contact_id,file_id,folder_id,revision)
    SELECT workspace_id,contact_id,file_id,${folderId},1 FROM contact_file_versions
    WHERE workspace_id=${workspaceId} AND contact_id=${peerContact.id} AND name='scope.txt'`;
  await sql`INSERT INTO contact_file_versions(workspace_id,contact_id,file_id,version_id,revision,name,size,sha256,created_at)
    SELECT ${workspaceId},CASE WHEN n=0 THEN ${hidden}::uuid ELSE ${peerContact.id}::uuid END,
      gen_random_uuid(),gen_random_uuid(),1,CASE WHEN n=0 THEN 'Restricted handout' ELSE 'Team handout '||n END,
      12,repeat('0',64),now() FROM generate_series(0,26) n`;
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const [name,value]=other.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    await page.goto(origin+'/?contact='+peerContact.id+'&workspaceId='+workspaceId);
    await page.getByRole('link',{name:'View in Files library'}).click();
    assert.equal(new URL(page.url()).searchParams.get('contactId'),peerContact.id);
    await page.getByRole('button',{name:'Open navigation'}).click();
    const nav=page.getByRole('navigation',{name:'Main navigation'});
    await nav.getByRole('button',{name:'Content',exact:true}).click();
    await nav.getByRole('link',{name:'Files',exact:true}).click();
    assert.equal(new URL(page.url()).search,new URL(fileLibrary,origin).search);
    await page.getByLabel('Search files or Contacts').fill('scope.txt');
    await page.getByLabel('Sort by').selectOption('name');
    await page.getByRole('button',{name:'Apply',exact:true}).click();
    const download=await page.getByRole('link',{name:'scope.txt',exact:true}).getAttribute('href');
    assert.equal(new URL(download,origin).searchParams.get('workspaceId'),workspaceId);
    assert.equal(await (await context.request.get(origin+download)).text(),bytes);
    assert.doesNotMatch(await page.content(),/Private filing cabinet/);
    const receipt=await sql`SELECT record_ids FROM portable_record_access_events WHERE workspace_id=${workspaceId}
      AND actor_email='other@example.test' AND kind='contacts' AND action='related' ORDER BY occurred_at DESC LIMIT 1`;
    assert.deepEqual(receipt[0].record_ids,[peerContact.id]);
    await page.getByLabel('Search files or Contacts').fill('handout');
    await page.getByRole('button',{name:'Apply',exact:true}).click();
    const rows=page.locator('tbody tr');
    await page.getByRole('link',{name:'Next page'}).waitFor();
    const first=await rows.locator('td:first-child').allTextContents();
    assert.equal(first.length,25);
    await page.getByRole('link',{name:'Next page'}).click();
    const saved=new URL(page.url());
    assert.equal(saved.searchParams.get('workspaceId'),workspaceId);
    const names=first.concat(await rows.locator('td:first-child').allTextContents());
    assert.deepEqual(names.sort(),Array.from({length:26},(_,i)=>'Team handout '+(i+1)).sort());
    return saved.pathname+saved.search;
  }finally{await browser.close();}
}

async function verifyMemberPreview({origin,headers,memberId,deal}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=settings&section=properties&member='+memberId);
    await page.getByText('Check a specific record',{exact:true}).click();
    await page.getByLabel('Record type',{exact:true}).selectOption('deals');
    await page.getByLabel('Find a deal',{exact:true}).fill(deal.data.name);
    await page.getByLabel('Record to check').selectOption(deal.id);
    await page.getByText('Can view only',{exact:true}).waitFor();
    await page.getByLabel('Record type',{exact:true}).selectOption('companies');
    assert.equal(await page.getByText('Can view only',{exact:true}).count(),0);
  }finally{await browser.close();}
}
