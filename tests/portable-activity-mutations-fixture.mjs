import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const endpoint='/api/logged-activities?';
const write=(request,origin,headers,path,body)=>request(path,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
  body:JSON.stringify(body)});
const update=(activity,occurredAt,summary)=>({action:'update',id:activity.id,expectedRevision:activity.revision,occurredAt,summary});
const remove=activity=>({action:'remove',id:activity.id,expectedRevision:activity.revision});
const empty={items:[],lastContacted:null,lastActivity:null,next:null};

export async function verifyPortableActivityMutations({request,origin,headers,other,sql,sharing}){
  const get=(path,auth=headers)=>request(path,{headers:auth});
  const post=(path,body,auth=headers,site=origin)=>write(request,site,auth,path,body);
  const resetBudgets=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const viewerEmail='other@example.test';
  const changeGrant=async (action,fields)=>{
    const response=await post('/api/workspaces',{action,id:sharing.grantId,...fields});
    assert.equal(response.status,200,await response.clone().text());
    const viewer=(await response.json()).viewers.find(entry=>entry.email===viewerEmail);
    sharing.grantId=viewer.id;
    return viewer;
  };
  await resetBudgets();
  const originalGrant=(await (await get('/api/workspaces')).json()).viewers.find(entry=>entry.email===viewerEmail);
  assert.equal(originalGrant.role,'editor');
  assert.equal(originalGrant.contactOutreach,true);
  assert.equal(originalGrant.recordActivities,false);
  const workspace='&workspaceId='+sharing.workspaceId;
  const grant=()=>'&grantId='+sharing.grantId;
  const identities=Object.fromEntries((await sql`SELECT email,id FROM login_identities
    WHERE email IN ('owner@example.test',${viewerEmail})`).map(({email,id})=>[email,id]));
  const cases=[],base=Date.now()-60_000;
  const commonId=randomUUID();
  for(const kind of ['contacts','companies','deals']){
    const created=await post('/api/crm',{action:'save',kind,data:{name:'Fictional activity edit '+kind}});
    assert.equal(created.status,201,await created.clone().text());
    const {record}=await created.json();
    const path=endpoint+new URLSearchParams(kind==='contacts'?{contactId:record.id}:{kind,recordId:record.id});
    const sharedPath=()=>path+workspace+grant();
    const auditPath=path+'&removed=1';
    const sharedAudit=auditPath+workspace;
    const rowTable=kind==='contacts'?'portable_contact_activities':'portable_record_activities';
    const call={id:kind==='deals'?randomUUID():commonId,kind:'Call',occurredAt:base-1000,summary:'Fictional call to remove'};
    const meeting={id:randomUUID(),kind:'Meeting',occurredAt:base-500,summary:'Fictional meeting to edit'};
    const note={id:randomUUID(),kind:'Note',occurredAt:base,summary:'Fictional latest note'};
    for(const body of [call,meeting,note])assert.equal((await post(path,body)).status,201);
    assert.deepEqual((await (await get(path)).json()).items.map(row=>row.revision),[1,1,1]);
    assert.deepEqual(await (await get(auditPath)).json(),{items:[],next:null});
    assert.equal((await get(sharedAudit,{})).status,401);
    assert.equal((await get(auditPath,other)).status,404);
    assert.equal((await get(sharedAudit+grant(),other)).status,400);
    const history=path+'&history='+meeting.id;
    const sharedHistory=history+workspace;
    assert.equal((await get(history,{})).status,401);
    assert.equal((await get(history,other)).status,404);
    assert.deepEqual(await (await get(history)).json(),{items:[],next:null});
    assert.equal((await get(path+'&history='+randomUUID())).status,404);
    assert.equal((await get(history+'&before=abc')).status,400);
    const unchanged=update({...meeting,revision:1},meeting.occurredAt,meeting.summary);
    assert.deepEqual(await (await post(path,unchanged)).json(),{id:meeting.id,revision:1});
    const edit=update({...meeting,revision:1},base-2000,'Edited fictional meeting');
    assert.equal((await post(path,edit,{})).status,401);
    assert.equal((await post(path,edit,other)).status,404);
    assert.equal((await post(path,remove({...note,revision:1}),other)).status,404);
    assert.equal((await post(path,edit,headers,'https://outside.example.test')).status,403);
    assert.equal((await post(path,{...edit,occurredAt:Date.now()+60_000})).status,400);
    if(kind==='contacts'){
      const shared=sharedPath();
      const sharedNote={id:randomUUID(),kind:'Note',occurredAt:base-3000,summary:'Fictional teammate note'};
      assert.equal((await post(shared,sharedNote,other)).status,201);
      assert.equal((await get(shared+'&history='+sharedNote.id,other)).status,400);
      assert.equal((await post(shared,remove({...sharedNote,revision:2}),other)).status,409);
      assert.equal((await post(path,remove({...sharedNote,revision:1}))).status,200);
      assert.equal((await post(shared,sharedNote,other)).status,410);
      assert.equal((await post(path,sharedNote)).status,409,'Only the original author can replay its creation.');
      await sql`ALTER TABLE portable_activity_history ADD CONSTRAINT fixture_edit_failure CHECK (summary<>'Reject this edit')`;
      try{
        assert.equal((await post(shared,{...edit,summary:'Reject this edit'},other)).status,503);
        assert.equal((await sql`SELECT revision FROM portable_contact_activities WHERE id=${meeting.id}`)[0].revision,1);
        assert.equal((await sql`SELECT count(*)::int AS count FROM portable_activity_creation_receipts WHERE id=${meeting.id}`)[0].count,0);
        assert.deepEqual(await (await get(history)).json(),{items:[],next:null});
      }finally{await sql`ALTER TABLE portable_activity_history DROP CONSTRAINT fixture_edit_failure`;}
    }
    const edited=await Promise.all([post(path,edit),post(path,edit)]);
    assert.deepEqual(edited.map(response=>response.status).sort(),[200,409]);
    assert.deepEqual(await edited.find(response=>response.status===200).json(),{id:meeting.id,revision:2});
    const changed=await get(history);
    assert.equal(changed.headers.get('cache-control'),'private, no-store');
    let savedHistory=await changed.json();
    assert.equal(savedHistory.next,null);
    assert.equal(savedHistory.items.length,1);
    const [{editedAt,...entry}]=savedHistory.items;
    assert.ok(editedAt>=base&&editedAt<=Date.now());
    assert.deepEqual(entry,{revision:2,editorName:'Harbor Fixture',previousAt:meeting.occurredAt,
      previousSummary:meeting.summary,occurredAt:edit.occurredAt,summary:edit.summary});
    const flag=kind==='contacts'?'contact_outreach':'record_activities';
    const previouslyEnabled=kind==='contacts';
    const teammateEdit=update({...meeting,revision:2},base-2500,'Corrected by fictional teammate');
    if(!previouslyEnabled){
      assert.equal((await get(sharedHistory,other)).status,404);
      assert.equal((await post(sharedPath(),teammateEdit,other)).status,403);
    }
    try{
      if(!previouslyEnabled)await changeGrant(flag,{enabled:true});
      const sharedSaved=await get(sharedHistory,other);
      assert.equal(sharedSaved.status,200);
      assert.equal(sharedSaved.headers.get('cache-control'),'private, no-store');
      assert.deepEqual(await sharedSaved.json(),savedHistory);
      assert.equal((await get(sharedHistory.replace(record.id,randomUUID()),other)).status,404);
      assert.equal((await get(sharedHistory.replace(sharing.workspaceId,randomUUID()),other)).status,404);
      const editingPath=sharedPath();
      const wrongRecord=editingPath.replace(record.id,randomUUID());
      assert.equal((await post(wrongRecord,teammateEdit,other)).status,404);
      assert.equal((await post(wrongRecord,remove({...note,revision:1}),other)).status,404);
      const teammateResponse=await post(editingPath,teammateEdit,other);
      assert.equal(teammateResponse.status,200,await teammateResponse.clone().text());
      assert.deepEqual(await teammateResponse.json(),{id:meeting.id,revision:3});
      assert.equal((await post(editingPath,teammateEdit,other)).status,409);
      assert.equal((await post(editingPath,remove({...meeting,revision:2}),other)).status,409);
      assert.equal((await post(editingPath,meeting,other)).status,409,'Editing does not transfer the original creation receipt.');
      const updatedHistory=await (await get(history)).json();
      const [{editedAt:teammateEditedAt,...teammateRevision},...priorRevisions]=updatedHistory.items;
      assert.ok(teammateEditedAt>=editedAt&&teammateEditedAt<=Date.now());
      assert.deepEqual(priorRevisions,savedHistory.items);
      assert.deepEqual(teammateRevision,{revision:3,editorName:'Harbor Fixture',
        previousAt:edit.occurredAt,previousSummary:edit.summary,occurredAt:teammateEdit.occurredAt,summary:teammateEdit.summary});
      assert.deepEqual((await sql`SELECT a.actor_id,h.editor_id FROM ${sql(rowTable)} a
        JOIN portable_activity_history h ON h.workspace_id=a.workspace_id AND (h.contact_activity_id=a.id OR h.record_activity_id=a.id)
        WHERE a.id=${meeting.id} AND h.revision=3`)[0],{actor_id:identities['owner@example.test'],editor_id:identities[viewerEmail]});
      savedHistory=updatedHistory;

      await changeGrant('role',{role:'viewer'});
      assert.deepEqual(await (await get(sharedHistory,other)).json(),savedHistory);
      const deniedEdit={...teammateEdit,expectedRevision:3,summary:'This must not be saved'};
      assert.equal((await post(sharedPath(),deniedEdit,other)).status,403);
      assert.equal((await post(sharedPath(),remove({...note,revision:1}),other)).status,403);
      await changeGrant('role',{role:'editor'});
      assert.equal((await post(editingPath,deniedEdit,other)).status,403,'A former editor grant cannot authorize an edit.');
      assert.equal((await post(editingPath,remove({...note,revision:1}),other)).status,403);
      await changeGrant(flag,{enabled:false});
      assert.equal((await post(sharedPath(),deniedEdit,other)).status,403);
      assert.equal((await post(sharedPath(),remove({...note,revision:1}),other)).status,403);
      assert.equal((await get(sharedHistory,other)).status,404,'An existing session loses history when its activity permission is removed.');
      assert.deepEqual(await (await get(history)).json(),savedHistory);
    }finally{
      await changeGrant(flag,{enabled:previouslyEnabled});
      await changeGrant('role',{role:originalGrant.role});
    }
    if(kind==='contacts'){
      const gmailHistory=endpoint+new URLSearchParams({contactId:sharing.neverLog.contactId,history:sharing.neverLog.active.id});
      const gmailPage=await get(gmailHistory);
      assert.equal(gmailPage.status,200);
      assert.equal((await gmailPage.json()).items.length,1);
      assert.equal((await get(gmailHistory+workspace,other)).status,404,'Earlier Gmail excerpts are owner-only.');
      const gmailPath=endpoint+new URLSearchParams({contactId:sharing.neverLog.contactId});
      const gmailActivity=sharing.neverLog.active;
      assert.equal((await post(gmailPath+workspace+grant(),update(gmailActivity,gmailActivity.occurredAt,'Foreign Gmail edit'),other)).status,404);
      assert.equal((await post(gmailPath+workspace+grant(),remove(gmailActivity),other)).status,404);
      await sql`UPDATE contacts SET archived_at=now() WHERE id=${record.id}`;
      try{
        assert.equal((await get(history)).status,404);
        assert.equal((await get(sharedHistory,other)).status,404);
      }finally{await sql`UPDATE contacts SET archived_at=NULL WHERE id=${record.id}`;}
      assert.deepEqual(await (await get(history)).json(),savedHistory);

      // Exercise real edits across the page boundary before removing this Note.
      for(let revision=1;revision<=26;revision++){
        assert.equal((await post(path,update({...note,revision},note.occurredAt,'Fictional edit '+revision))).status,200);
      }
      note.revision=27;
      const noteHistory=path+'&history='+note.id;
      const first=await (await get(noteHistory)).json();
      assert.deepEqual(first.items.map(change=>change.revision),Array.from({length:25},(_,i)=>27-i));
      assert.equal(first.next,3);
      const second=await (await get(noteHistory+'&before='+first.next)).json();
      assert.deepEqual(second.items.map(change=>change.revision),[2]);
      assert.equal(second.next,null);
      assert.deepEqual(await (await get(noteHistory+workspace,other)).json(),first);
      assert.deepEqual(await (await get(noteHistory+workspace+'&before='+first.next,other)).json(),second);
    }
    const retry=await post(path,meeting);
    assert.equal(retry.status,200);
    assert.deepEqual(await retry.json(),{id:meeting.id});
    assert.equal((await post(path,{...meeting,summary:edit.summary,occurredAt:edit.occurredAt})).status,409);
    assert.equal((await post(path,remove({...meeting,revision:1}))).status,409);
    const afterEdit=await (await get(path)).json();
    assert.equal(afterEdit.lastContacted,call.occurredAt);
    assert.equal(afterEdit.lastActivity,note.occurredAt);
    const latest={...meeting,occurredAt:teammateEdit.occurredAt,summary:teammateEdit.summary,revision:3};
    assert.deepEqual(afterEdit.items.find(row=>row.id===meeting.id),latest);
    const noteHistory=path+'&history='+note.id;
    let savedAudit;
    try{
      if(!previouslyEnabled)await changeGrant(flag,{enabled:true});
      const noteRemoval=remove({...note,revision:note.revision??1});
      if(kind==='contacts'){
        await sql`ALTER TABLE portable_activity_removals ADD CONSTRAINT fixture_audit_failure CHECK (kind<>'Note') NOT VALID`;
        try{
          assert.equal((await post(sharedPath(),noteRemoval,other)).status,503);
          assert.deepEqual(await (await get(path)).json(),afterEdit);
          assert.equal((await get(noteHistory)).status,200);
          assert.deepEqual(await (await get(auditPath)).json(),{items:[],next:null});
        }finally{await sql`ALTER TABLE portable_activity_removals DROP CONSTRAINT fixture_audit_failure`;}
      }
      const requests=await Promise.all([post(sharedPath(),noteRemoval,other),post(sharedPath(),noteRemoval,other)]);
      assert.deepEqual(requests.map(response=>response.status).sort(),[200,404]);
      assert.deepEqual(await requests.find(response=>response.status===200).json(),{ok:true});
      assert.equal((await post(path,{id:note.id,kind:note.kind,occurredAt:note.occurredAt,summary:note.summary})).status,410);
      const audit=await get(sharedAudit,other);
      assert.equal(audit.status,200,await audit.clone().text());
      assert.equal(audit.headers.get('cache-control'),'private, no-store');
      const auditPage=await audit.json();
      assert.deepEqual(auditPage,await (await get(auditPath)).json());
      assert.equal(auditPage.items.length,1);
      const [{removedAt,...metadata}]=auditPage.items;
      assert.ok(removedAt>=base&&removedAt<=Date.now());
      assert.deepEqual(metadata,{id:note.id,kind:'Note',removedBy:'Harbor Fixture'});
      assert.equal(auditPage.next,null);
      assert.deepEqual((await sql`SELECT removed_by_id FROM portable_activity_removals
        WHERE workspace_id=${sharing.workspaceId} AND record_id=${record.id} AND id=${note.id}`)[0],{removed_by_id:identities[viewerEmail]});
      savedAudit=auditPage;
      await changeGrant('role',{role:'viewer'});
      assert.deepEqual(await (await get(sharedAudit,other)).json(),auditPage);
      assert.equal((await get(sharedAudit.replace(record.id,randomUUID()),other)).status,404);
      assert.equal((await get(sharedAudit.replace(sharing.workspaceId,randomUUID()),other)).status,404);
      await changeGrant(flag,{enabled:false});
      assert.equal((await get(sharedAudit,other)).status,404);
    }finally{
      await changeGrant(flag,{enabled:previouslyEnabled});
      await changeGrant('role',{role:originalGrant.role});
    }
    assert.equal((await get(noteHistory)).status,404);
    assert.equal((await sql`SELECT count(*)::int AS count FROM portable_activity_history
      WHERE contact_activity_id=${note.id} OR record_activity_id=${note.id}`)[0].count,0);
    const withoutNote=await (await get(path)).json();
    assert.equal(withoutNote.lastActivity,call.occurredAt);
    assert.equal(withoutNote.lastContacted,call.occurredAt);
    const removed=await post(path,remove({...call,revision:1}));
    assert.equal(removed.status,200);
    assert.deepEqual(await removed.json(),{ok:true});
    assert.equal((await post(path,call)).status,410);
    assert.equal((await post(path,{...call,summary:'Wrong retry'})).status,409);
    assert.equal((await sql`SELECT count(*)::int AS count FROM ${sql(rowTable)} WHERE id=${call.id}`)[0].count,0);
    if(kind==='companies'){
      assert.equal((await post(path,remove(latest))).status,200);
      assert.equal((await get(history)).status,404);
      assert.equal((await sql`SELECT count(*)::int AS count FROM portable_activity_history WHERE record_activity_id=${meeting.id}`)[0].count,0);
    }
    const after=await (await get(path)).json();
    const expected=kind==='companies'?empty:{items:[latest],lastContacted:latest.occurredAt,lastActivity:latest.occurredAt,next:null};
    assert.deepEqual(after,expected);
    assert.deepEqual(await (await get(auditPath)).json(),savedAudit);
    cases.push({path,expected,meeting,call,history,savedHistory:kind==='companies'?null:savedHistory,auditPath,sharedAudit,savedAudit});
    await resetBudgets();
  }
  const receipts=await sql`SELECT namespace,fingerprint FROM portable_activity_creation_receipts WHERE id=${commonId} ORDER BY namespace`;
  assert.deepEqual(receipts.map(row=>row.namespace),['contact','record']);
  assert.ok(receipts.every(row=>/^[a-f0-9]{64}$/.test(row.fingerprint)));
  await resetBudgets();
  return cases;
}

export async function verifyRestoredActivityMutations({request,origin,owner,other,cases}){
  for(const {path,expected,meeting,call,history,savedHistory,auditPath,sharedAudit,savedAudit} of cases){
    const page=await request(history,{headers:owner});
    if(savedHistory)assert.deepEqual(await page.json(),savedHistory);
    else assert.equal(page.status,404);
    assert.equal((await request(history,{headers:other})).status,404);
    assert.deepEqual(await (await request(auditPath,{headers:owner})).json(),savedAudit);
    assert.equal((await request(sharedAudit,{headers:other})).status,404);
    assert.deepEqual(await (await request(path,{headers:owner})).json(),expected);
    assert.equal((await request(path,{headers:other})).status,404);
    assert.equal((await write(request,origin,owner,path,meeting)).status,expected.items.length?200:410);
    assert.equal((await write(request,origin,owner,path,call)).status,410);
    assert.deepEqual(await (await request(path,{headers:owner})).json(),expected);
  }
}
