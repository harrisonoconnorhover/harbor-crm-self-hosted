import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const contactEmail='outlook-record@example.test',excluded='protected-recipient@example.test';
const day=86_400_000,mailPath='/v1.0/me/mailFolders/inbox/messages',eventPath='/v1.0/me/calendar/calendarView';
const person=address=>({emailAddress:{address}});
const iso=at=>new Date(at).toISOString();
const utc=at=>({dateTime:iso(at).replace('Z','0000'),timeZone:'UTC'});

export async function outlookRecordsFetch(url,options){
  if(url.origin!=='https://graph.microsoft.com'||![mailPath,eventPath].includes(url.pathname))return;
  const isMail=url.pathname===mailPath,provider=isMail?'outlook-mail':'outlook-calendar';
  const headers=new Headers(options?.headers),auth=headers.get('authorization')??'',prefix='Bearer outlook-test:'+provider+':';
  assert.ok(auth.startsWith(prefix),'Outlook fixture expected the matching delegated token.');
  const mailbox=auth.slice(prefix.length);
  assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
  assert.match(headers.get('prefer'),/IdType="ImmutableId"/);assert.match(headers.get('prefer'),/outlook.timezone="UTC"/);
  assert.equal(url.searchParams.get('$top'),'25');
  const select=url.searchParams.get('$select').split(',');
  assert.ok(!select.includes('body')&&!select.includes('attachments'));
  const filter=url.searchParams.get('$filter')??'';
  const boundary=isMail?filter.match(/receivedDateTime lt ([^ ]+) and from\/emailAddress\/address eq '([^']+)'$/):null;
  if(isMail)assert.ok(boundary);
  const end=Date.parse(isMail?boundary[1]:url.searchParams.get('endDateTime')),when=end-2*3_600_000;
  const next=new URL(url);next.searchParams.set('$skip','25');
  if(isMail){
    const from=boundary[2];
    assert.equal(url.searchParams.get('$orderby'),'receivedDateTime desc');
    const item={id:'graph-inbox-first',subject:'Proposal from contact',bodyPreview:'Private preview only.',receivedDateTime:iso(when),
      from:person(contactEmail.toUpperCase()),sender:person(contactEmail),toRecipients:[person(mailbox)],ccRecipients:[],bccRecipients:[],isDraft:false};
    if(from==='outlook-continuation@example.test')return Response.json({value:[], '@odata.nextLink':'https://unexpected.example.test/never-request'});
    if(from!==contactEmail)return Response.json({value:[]});
    if(url.searchParams.has('$skip'))return Response.json({value:[{...item,id:'graph-inbox-second',subject:'Another received message'}]});
    return Response.json({value:[item,{...item,id:'hidden-copy',subject:'Hidden by Never Log',bccRecipients:[person(excluded)]},
      {...item,id:'wrong',from:person('stranger@example.test')},{...item,id:'alias',sender:person('stranger@example.test')},
      {...item,id:'draft',isDraft:true},{...item,id:'not-a-message','@odata.type':'#microsoft.graph.eventMessage'},
      {...item,id:'future',receivedDateTime:iso(Date.now()+day)}],'@odata.nextLink':next.href});
  }
  const self=person(mailbox),guest={...person(contactEmail),type:'required',status:{response:'accepted'}};
  const event={id:'graph-event-ended',subject:'Quarterly review',isCancelled:false,isAllDay:false,hideAttendees:false,sensitivity:'normal',
    type:'occurrence',isOrganizer:true,responseStatus:{response:'organizer'},organizer:self,attendees:[guest],start:utc(when-3_600_000),end:utc(when)};
  return Response.json({value:[event,{...event,id:'future',end:utc(Date.now()+day)},{...event,id:'cancelled',isCancelled:true},
    {...event,id:'tentative',attendees:[{...guest,status:{response:'tentativelyAccepted'}}]},
    {...event,id:'declined',isOrganizer:false,organizer:person(contactEmail),responseStatus:{response:'declined'}},
    {...event,id:'unrelated',attendees:[{...guest,...person('other-contact@example.test')}]},{...event,id:'all-day',isAllDay:true},
    {...event,id:'private',sensitivity:'private'},{...event,id:'series',type:'seriesMaster'},
    {...event,id:'private-recipient',subject:'Private event subject',attendees:[guest,{...guest,...person(excluded)}]},
    {...event,id:'hidden-attendees',hideAttendees:true},{...event,id:'unanswered',attendees:[{...guest,status:{response:'none'}}]}]});
}

export async function verifyOutlookRecords({request,origin,headers,other,sql}){
  const now=Date.now(),through=iso(now-day).slice(0,10),when=Date.parse(through+'T22:00:00Z');
  const post=(path,method,body,auth=headers)=>request(path,{method,headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(12_000)});
  const good=async(response,expected=200)=>{assert.equal(response.status,expected,await response.clone().text());return response.json();};
  const [workspace]=await sql`SELECT w.id FROM private_workspaces w JOIN login_identities u ON u.id=w.owner_id WHERE u.email='owner@example.test'`;
  const contactIds=[],activityIds=[],duplicateId=randomUUID(),ruleId=randomUUID(),blockedRule=randomUUID();
  const createContact=async(name,email)=>{
    const {record}=await good(await post('/api/crm','POST',{action:'save',kind:'contacts',data:{name,email}}),201);
    contactIds.push(record.id);
    return record;
  };
  const path='/api/outlook-records',rules='/api/email/never-log';
  const lookup=(body,auth=headers)=>post(path,'POST',body,auth);
  const write=body=>post(path,'PUT',body);
  try{
    const record=await createContact('Outlook record fixture',contactEmail);
    const continuation=await createContact('Outlook pagination fixture','outlook-continuation@example.test');
    // Exercise an existing duplicate such as one inherited from a previous import.
    await sql`INSERT INTO contacts (workspace_id,id,revision,data,created_at,updated_at)
      SELECT workspace_id,${duplicateId},1,data,now(),now() FROM contacts WHERE workspace_id=${workspace.id} AND id=${record.id}`;
    contactIds.push(duplicateId);
    const base={recordId:record.id,through,days:7};
    const mail={...base,provider:'outlook-mail'},calendar={...base,provider:'outlook-calendar'};
    const timelinePath='/api/logged-activities?contactId='+record.id;
    const timeline=()=>request(timelinePath,{headers}).then(good);
    await good(await post(rules,'POST',{id:ruleId,value:excluded}));
    const searches=await Promise.all([lookup(mail).then(good),lookup(calendar).then(good)]);
    assert.deepEqual(searches[0].items.map(item=>item.subject).sort(),['Another received message','Proposal from contact']);
    assert.deepEqual(searches[1].items.map(item=>item.subject),['Quarterly review']);
    assert.ok(!JSON.stringify(searches).includes('graph-inbox')&&!JSON.stringify(searches).includes(excluded));
    assert.ok(!(await timeline()).items.length,'search and RSVP do not log outreach');
    assert.equal((await lookup(mail,other)).status,404);
    assert.equal((await post(path+'?workspaceId='+randomUUID(),'POST',mail)).status,403);
    assert.equal((await lookup({...mail,through:'2099-12-02'})).status,400);
    assert.equal((await lookup({...mail,recordId:continuation.id})).status,503);
    const selected=searches[0].items.find(item=>item.subject==='Proposal from contact');
    assert.equal(selected.excerpt,'Private preview only.');
    assert.equal((await write({...mail,selection:selected.selection,recordId:duplicateId})).status,409);
    const calendarItem=searches[1].items[0];
    assert.equal((await write({...calendar,selection:calendarItem.selection})).status,400);
    assert.equal((await write({...calendar,selection:calendarItem.selection,attended:false})).status,400);
    const saves=await Promise.all([write({...mail,selection:selected.selection}).then(good),write({...mail,selection:selected.selection}).then(good)]);
    assert.deepEqual(saves.map(item=>item.alreadyLogged).sort(),[false,true]);
    assert.equal((await good(await write({...calendar,selection:calendarItem.selection,attended:true}))).alreadyLogged,false);
    const logged=await timeline();
    activityIds.push(...logged.items.map(item=>item.id));
    assert.equal(logged.items.length,2);assert.equal(logged.lastContacted,when);
    assert.deepEqual(logged.items.map(item=>[item.kind,item.occurredAt,item.summary]).sort(),[
      ['Email',when,'Received in Outlook: Proposal from contact'],['Meeting',when,'Attended meeting in Outlook: Quarterly review']]);
    const emailActivity=logged.items.find(item=>item.kind==='Email');
    const meetingActivity=logged.items.find(item=>item.kind==='Meeting');
    await good(await post(timelinePath,'POST',{action:'update',id:meetingActivity.id,expectedRevision:1,
      occurredAt:meetingActivity.occurredAt,summary:'Updated meeting summary'}));
    assert.equal((await good(await write({...calendar,selection:calendarItem.selection,attended:true}))).alreadyLogged,true);
    assert.equal((await timeline()).items.find(item=>item.id===meetingActivity.id).summary,'Updated meeting summary');
    const otherLookup=await good(await lookup({...mail,recordId:duplicateId}));
    assert.equal(otherLookup.items.find(item=>item.subject===selected.subject).logged,true);
    await good(await post(timelinePath,'POST',{action:'remove',id:emailActivity.id,expectedRevision:1}));
    assert.equal((await good(await write({...mail,selection:selected.selection}))).alreadyLogged,true);
    assert.equal((await timeline()).items.length,1,'replay must not resurrect a removed log');
    const [count]=await sql`SELECT count(*)::int AS total FROM portable_activity_creation_receipts WHERE id=${emailActivity.id}`;
    assert.equal(count.total,1);
    await good(await post('/api/crm','POST',{action:'patchContactText',id:record.id,expectedRevision:record.revision,
      field:'name',value:'Renamed Outlook fixture'}));
    assert.equal((await write({...calendar,selection:calendarItem.selection,attended:true})).status,409);
    await good(await post(rules,'POST',{id:blockedRule,value:contactEmail}));
    assert.deepEqual((await good(await lookup(mail))).items,[]);
  }finally{
    await sql.begin(async tx=>{
      await tx`DELETE FROM portable_never_log_rules WHERE workspace_id=${workspace.id} AND id IN (${ruleId},${blockedRule})`;
      await tx`DELETE FROM portable_activity_creation_receipts WHERE workspace_id=${workspace.id} AND namespace='contact' AND (id=ANY(${activityIds}::uuid[]) OR id IN (
        SELECT id FROM portable_contact_activities WHERE workspace_id=${workspace.id} AND contact_id=ANY(${contactIds}::uuid[])
        UNION SELECT id FROM portable_activity_removals WHERE workspace_id=${workspace.id} AND record_kind='contacts' AND record_id=ANY(${contactIds}::uuid[])))`;
      await tx`DELETE FROM portable_activity_removals WHERE workspace_id=${workspace.id} AND record_kind='contacts' AND record_id=ANY(${contactIds}::uuid[])`;
      await tx`DELETE FROM portable_contact_activities WHERE workspace_id=${workspace.id} AND contact_id=ANY(${contactIds}::uuid[])`;
      await tx`DELETE FROM contact_events WHERE workspace_id=${workspace.id} AND contact_id=ANY(${contactIds}::uuid[])`;
      await tx`DELETE FROM contacts WHERE workspace_id=${workspace.id} AND id=ANY(${contactIds}::uuid[])`;
    });
  }
}
