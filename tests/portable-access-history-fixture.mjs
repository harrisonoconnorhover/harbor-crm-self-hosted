import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifyAccessCsv} from './portable-access-csv-fixture.mjs';
import {verifyImportAccess} from './portable-import-access-fixture.mjs';
import {verifyListAccess} from './portable-list-access-fixture.mjs';
import {verifyWorkItemHistory} from './portable-work-item-history-fixture.mjs';

import {verifySuggestedDuplicatePaging} from './portable-suggested-duplicate-paging-fixture.mjs';
import {verifyDismissedDuplicatePaging} from './portable-dismissed-duplicate-paging-fixture.mjs';
import {verifyDuplicateReviewAccess} from './portable-duplicate-review-access-fixture.mjs';

export async function verifyAccessHistory({request,origin,headers,other,sql}){
  const get=(path,auth=headers,method='GET')=>request(path,{method,headers:auth});
  const send=(path,body,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const ok=async promise=>{const r=await promise;assert.ok(r.ok,await r.clone().text());return r;};
  const create=async(kind,name)=>(await (await ok(send('/api/crm',{action:'save',kind,data:{name}}))).json()).record.id;
  const count=async()=>(await sql`SELECT count(*)::int as n FROM portable_record_access_events`)[0].n;
  const kinds=['contacts','companies','deals'],ids={};
  for(const kind of kinds)ids[kind]=await create(kind,'Fictional access review');
  const workspace=await(await ok(send('/api/workspaces',{action:'grant',email:'other@example.test'}))).json();
  const grant=workspace.viewers.find(person=>person.email==='other@example.test');
  for(const kind of kinds){
    const id=ids[kind],extra=await create(kind,'Unrelated example');
    const path=kind==='contacts'?'/?contact='+id:'/?kind='+kind+'&record='+id;
    const page=await(await ok(get(path+'&workspaceId='+workspace.owned,other))).text();
    assert.match(page,/Fictional access review/);
    assert.ok(!page.includes('View record access history'));
    const api='/api/crm?kind='+kind;
    await ok(get(api+'&id='+id));await ok(get(api+'&search=Fictional'));
    const listPath='/?kind='+kind+'&search=Fictional&workspaceId='+workspace.owned;
    assert.ok((await(await ok(get(listPath,other))).text()).includes(id));
    await ok(get(api+'&export=csv',headers,'HEAD'));
    const csv=await(await ok(get(api+'&export=csv&search=Fictional'))).text();
    assert.ok(csv.includes(id)&&!csv.includes(extra));
    assert.equal((await get(api+'&id='+id,other)).status,404);
    assert.equal((await get(api+'&id='+randomUUID())).status,404);
    const rows=await sql`SELECT action,actor_email,record_ids FROM portable_record_access_events WHERE kind=${kind}`;
    assert.deepEqual(rows.map(r=>r.action+' '+r.actor_email).sort(),['csv owner@example.test','detail other@example.test','detail owner@example.test','list other@example.test','list owner@example.test']);
    assert.ok(rows.every(r=>r.record_ids.length===1&&r.record_ids[0]===id));
  }
  await ok(get('/?kind=deals&view=board'));
  const [board]=await sql`SELECT record_ids FROM portable_record_access_events WHERE kind='deals' AND action='list' AND cardinality(record_ids)=2`;
  assert.ok(board.record_ids.includes(ids.deals));
  const sharedSearch='/api/crm/search?workspaceId='+workspace.owned;
  const additional=['tasks','leads','tickets'];
  ids.tasks=await create('tasks','Fictional access review');
  ids.leads=(await (await ok(send('/api/leads',{action:'save',data:{name:'Fictional access review'}}))).json()).id;
  ids.tickets=(await (await ok(send('/api/tickets',{action:'save',data:{name:'Fictional access review'},
    contactId:ids.contacts,companyId:ids.companies}))).json()).record.id;
  const mixed=await (await ok(send(sharedSearch,{query:'Fictional access review'},other))).json();
  assert.deepEqual(mixed.results.map(row=>row.id).sort(),Object.values(ids).sort());
  const exposures=await sql`SELECT kind,record_ids,actor_email,workspace_id FROM portable_record_access_events WHERE action='search'`;
  assert.deepEqual(exposures.map(row=>row.kind).sort(),[...kinds,...additional].sort());
  for(const row of exposures){
    assert.deepEqual(row.record_ids,[ids[row.kind]]);
    assert.equal(row.actor_email,'other@example.test');
    assert.equal(row.workspace_id,workspace.owned);
  }
  for(const kind of additional){
    const report=(await (await ok(send('/api/reporting',{action:'report',definition:{kind,name:'Audit '+kind}}))).json()).item;
    const dashboard=(await (await ok(send('/api/reporting',{action:'dashboard',definition:{name:'Team '+kind,
      cards:[{reportId:report.id,wide:false}]},teamVisible:true}))).json()).item;
    for(const [identity,email,path] of [
      [headers,'owner@example.test','/api/reporting?view=reportRecords&id='+report.id+'&revision='+report.revision],
      [other,'other@example.test','/api/reporting?view=dashboardRecords&id='+dashboard.id+'&reportId='+report.id+'&workspaceId='+workspace.owned],
    ]){
      const before=await count();
      await ok(get(path,identity,'HEAD'));
      assert.equal(await count(),before);
      const page=await (await ok(get(path,identity))).json();
      assert.ok(page.records.some(row=>row.id===ids[kind]));
      const receipts=await sql`SELECT record_ids FROM portable_record_access_events WHERE action='report'
        AND kind=${kind} AND actor_email=${email} AND workspace_id=${workspace.owned}`;
      assert.deepEqual(receipts.map(row=>row.record_ids),[page.records.map(row=>row.id)]);
    }
  }
  await ok(send('/api/workspaces',{action:'revoke',id:grant.id}));
  assert.equal((await get('/api/crm?kind=contacts&id='+ids.contacts+'&workspaceId='+workspace.owned,other)).status,404);
  const {token,info}=await(await ok(send('/api/api-tokens',{name:'=Fictional, "access check"',objects:['contacts'],permission:'read',days:30}))).json();
  const auth={authorization:'Bearer '+token},base='/api/v1/records/contacts';
  await ok(get(base+'/'+ids.contacts,auth));await ok(get(base,auth));
  const batch=await send(base+'/batch/read',{inputs:[{id:ids.contacts},{id:randomUUID()}]},auth);
  assert.equal(batch.status,207);
  const reads=await sql`SELECT record_ids,token_id FROM portable_record_access_events WHERE action='integration' ORDER BY occurred_at,id`;
  assert.equal(reads.length,3);assert.ok(reads.every(row=>row.token_id===info.id&&row.record_ids.includes(ids.contacts)));
  assert.deepEqual(reads.map(row=>row.record_ids.length),[1,2,1]);
  const history='/?view=record-access';
  const filtered=await(await ok(get(history+'&action=csv&kind=companies&record='+ids.companies))).text();
  assert.ok(filtered.includes(ids.companies)&&!filtered.includes(ids.contacts));
  assert.match(filtered,/owner@example.test/);assert.doesNotMatch(filtered,/other@example.test/);
  const isolated=await(await ok(get(history,other))).text();
  assert.match(isolated,/No matching access events/);assert.ok(!isolated.includes(ids.companies));
  assert.ok(!(await get(history,{})).ok);
  const reportApi='/api/reporting';
  const grantAgain=await (await ok(send('/api/workspaces',{action:'grant',email:'other@example.test'}))).json();
  const member=grantAgain.viewers.find(person=>person.email==='other@example.test');
  const restricted=await (await ok(send('/api/workspaces',{action:'record_scope',id:member.id,viewScope:'owned',editScope:'owned'}))).json();
  const [rep]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  await sql`INSERT INTO contacts(workspace_id,id,data,revision,created_at,updated_at)
    SELECT ${workspace.owned}::uuid,gen_random_uuid(),jsonb_build_object('name','Audit paging '||i,
      'recordOwner',jsonb_build_object('workspaceId',${workspace.owned}::text,'userId',${rep.id}::text,'label','Rep')),
      1,now(),now() FROM generate_series(1,30) i`;
  const report=(await (await ok(send(reportApi,{action:'report',definition:{kind:'contacts',name:'Audit contacts'}}))).json()).item;
  const dashboard=(await (await ok(send(reportApi,{action:'dashboard',definition:{name:'Audit overview',
    cards:[{reportId:report.id,wide:false}]},teamVisible:true}))).json()).item;
  const ownDrill=reportApi+'?view=reportRecords&id='+report.id+'&revision='+report.revision;
  const sharedDrill=reportApi+'?view=dashboardRecords&id='+dashboard.id+'&reportId='+report.id+'&workspaceId='+workspace.owned;
  const beforePages=await count();
  await ok(get(ownDrill,headers,'HEAD'));
  await ok(get(sharedDrill,other,'HEAD'));
  await ok(get(reportApi+'?view=dashboard&id='+dashboard.id+'&workspaceId='+workspace.owned,other));
  assert.deepEqual((await (await ok(send(sharedSearch,{query:'Fictional access review'},other))).json()).results,[]);
  assert.equal(await count(),beforePages);
  const searchPage=await (await ok(send(sharedSearch,{query:'Audit paging',page:1},other))).json();
  assert.equal(searchPage.total,30);
  assert.equal(searchPage.results.length,8);
  const [searchReceipt]=await sql`SELECT record_ids FROM portable_record_access_events WHERE action='search' AND cardinality(record_ids)=8`;
  assert.deepEqual(searchReceipt.record_ids,searchPage.results.map(row=>row.id));
  const first=await (await ok(get(sharedDrill,other))).json();
  const last=await (await ok(get(sharedDrill+'&after='+first.next,other))).json();
  assert.deepEqual([first.records.length,last.records.length],[25,5]);
  assert.ok([...first.records,...last.records].every(row=>row.name.startsWith('Audit paging ')));
  const reportReceipts=await sql`SELECT record_ids FROM portable_record_access_events
    WHERE action='report' AND kind='contacts' AND workspace_id=${workspace.owned} AND actor_id=${rep.id} ORDER BY cardinality(record_ids) DESC`;
  assert.deepEqual(reportReceipts.map(row=>row.record_ids),[first,last].map(page=>page.records.map(row=>row.id)));
  const ownPage=await (await ok(get(ownDrill))).json();
  const [ownReceipt]=await sql`SELECT record_ids FROM portable_record_access_events WHERE action='report' AND kind='contacts' AND actor_email='owner@example.test'`;
  assert.deepEqual(ownReceipt.record_ids,ownPage.records.map(row=>row.id));
  const historyPage=await (await ok(get(history+'&action=search&record='+searchReceipt.record_ids[0]))).text();
  const searchRow=historyPage.replaceAll('<!-- -->','').match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
  assert.ok(searchRow?.includes('other@example.test')&&searchRow.includes('Search results'));
  const idsLink=searchRow.match(/href="([^"]+)"[^>]*>8 contacts[^<]*View IDs/);
  assert.ok(idsLink,searchRow);
  const eventPath=idsLink[1].replaceAll('&amp;','&');
  const expanded=await (await ok(get(eventPath))).text();
  const back=expanded.match(/href="([^"]+)"[^>]*>Back to results/);
  assert.equal(back?.[1].replaceAll('&amp;','&'),eventPath.split('&event=')[0]);
  assert.equal(new URL(eventPath,origin).searchParams.get('record'),searchReceipt.record_ids[0]);
  const idsShown=[...expanded.matchAll(/<li><a href="[^"]+">([a-f0-9-]{36})<\/a><\/li>/g)].map(match=>match[1]);
  assert.deepEqual(idsShown,searchReceipt.record_ids);
  assert.match(await (await ok(get(eventPath,other))).text(),/No matching access events/);
  for(const name of ['Preview A','Preview B']){
    await ok(send('/api/crm',{action:'save',kind:'deals',data:{name},companyId:ids.companies,primaryContactId:ids.contacts}));
  }
  const previewList='/api/crm?kind=deals&search=Preview';
  const previews=await (await ok(get(previewList))).json();
  assert.equal(previews.records.length,2);
  assert.ok(previews.records.every(row=>row.primaryContactId===ids.contacts&&row.companyId===ids.companies));
  const primaryReceipts=await sql`SELECT kind,record_ids FROM portable_record_access_events WHERE action='related' ORDER BY kind`;
  assert.deepEqual(primaryReceipts.map(row=>row.record_ids),[[ids.companies],[ids.contacts]]);
  const associate='/api/associations?kind=companies&id='+ids.companies;
  await ok(send(associate,{action:'link',target:{kind:'contacts',id:ids.contacts},labels:[]}));
  const beforeAssociation=await count();
  await ok(get(associate,headers,'HEAD'));
  assert.equal((await get(associate+'&workspaceId='+workspace.owned,other)).status,404);
  assert.equal(await count(),beforeAssociation);
  const linked=await (await ok(get(associate))).json();
  assert.equal(linked.items[0].target.id,ids.contacts);
  assert.equal(await count(),beforeAssociation+1);
  for(const columns of [['name'],['name','primaryContactName']]){
    const {view}=await (await ok(send('/api/crm/views',{action:'create',kind:'deals',name:'Preview export '+columns.length,
      filters:{search:'Preview'},columns}))).json();
    const beforeCsv=await count();
    const csv=await (await ok(get('/api/crm?kind=deals&export=csv&savedView='+view.id))).text();
    assert.equal(csv.includes('Fictional access review'),columns.length===2);
    assert.equal(await count(),beforeCsv+columns.length);
  }
  const exported=await sql`SELECT record_ids FROM portable_record_access_events WHERE action='csv' AND kind='contacts' AND ${ids.contacts}::uuid=ANY(record_ids)`;
  assert.equal(exported.length,2); // Original Contact CSV and the Deal CSV including its contact name.
  const taskExport='/api/crm?kind=tasks&export=csv&search=Linked';
  const taskIds=[];
  for(const kind of ['contacts','contacts','companies','deals']){
    const saved=await (await ok(send('/api/crm',{action:'save',kind:'tasks',related:{kind,id:ids[kind]},data:{name:'Linked '+kind+' task'}}))).json();
    taskIds.push(saved.record.id);
  }
  const beforeTaskExport=await count();
  await ok(get(taskExport,headers,'HEAD'));
  assert.equal((await get(taskExport+'&workspaceId='+workspace.owned,other)).status,403);
  assert.equal(await count(),beforeTaskExport);
  const taskCsv=await (await ok(get(taskExport))).text();
  assert.equal(await count(),beforeTaskExport+4);
  const [tasksReceipt]=await sql`SELECT record_ids FROM portable_record_access_events WHERE kind='tasks' AND action='csv'`;
  assert.deepEqual(tasksReceipt.record_ids.slice().sort(),taskIds.sort());
  assert.ok(tasksReceipt.record_ids.every(id=>taskCsv.includes(id)));
  for(const kind of kinds){
    assert.ok(taskCsv.includes(ids[kind]));
    const [entry]=await sql`SELECT record_ids FROM portable_record_access_events WHERE action='csv' AND kind=${kind} ORDER BY occurred_at DESC,id DESC LIMIT 1`;
    assert.deepEqual(entry.record_ids,[ids[kind]]);
  }
  const ticketExport='/api/tickets?export=csv&search=Fictional';
  const beforeTicketExport=await count();
  await ok(get(ticketExport,headers,'HEAD'));
  await ok(get('/api/tickets?export=csv&search=NoSuchTicket'));
  assert.equal((await get(ticketExport+'&workspaceId='+workspace.owned,other)).status,403);
  assert.equal(await count(),beforeTicketExport);
  const ticketCsv=await (await ok(get(ticketExport))).text();
  assert.equal(await count(),beforeTicketExport+3);
  for(const kind of ['tickets','contacts','companies']){
    assert.ok(ticketCsv.includes(ids[kind]));
    const [receipt]=await sql`SELECT record_ids FROM portable_record_access_events WHERE action='csv' AND kind=${kind}
      AND workspace_id=${workspace.owned} AND actor_email='owner@example.test' ORDER BY occurred_at DESC,id DESC LIMIT 1`;
    assert.deepEqual(receipt.record_ids,[ids[kind]]);
  }
  // If a linked receipt fails, roll back the otherwise valid list receipt as well.
  const beforeRelatedFailure=await count();
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT test_deny_related CHECK (action<>'related') NOT VALID`;
  try{
    const blocked=await get(previewList);
    assert.equal(blocked.status,500);
    assert.ok(!(await blocked.text()).includes(ids.contacts));
    assert.equal(await count(),beforeRelatedFailure);
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT test_deny_related`;}
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT test_deny_new_access CHECK (false) NOT VALID`;
  try{
    for(const path of ['/api/crm?kind=contacts&history='+ids.contacts,'/api/crm?kind=contacts&id='+ids.contacts,'/api/crm?kind=contacts&export=csv',taskExport,ticketExport]){
      const blocked=await get(path);
      assert.equal(blocked.status,path===ticketExport?503:500);
      assert.ok(!(await blocked.text()).includes(ids.contacts));
    }
    assert.equal((await get(base+'/'+ids.contacts,auth)).status,503);
    const beforeFailure=await count();
    for(const pending of [send(sharedSearch,{query:'Audit paging'},other),get(ownDrill),get(sharedDrill,other)]){
      const failed=await pending;
      assert.ok(failed.status>=500);
      assert.ok(!(await failed.text()).includes('Audit paging'));
    }
    assert.equal(await count(),beforeFailure);
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT test_deny_new_access`;}
  const before=await count();
  for(const verb of ['UPDATE portable_record_access_events SET actor_email=actor_email','DELETE FROM portable_record_access_events','TRUNCATE portable_record_access_events']){
    await assert.rejects(sql.unsafe(verb),/append-only/);
  }
  assert.equal(await count(),before);
  // The newest 25 results and the older page must be disjoint even with tied timestamps.
  for(let i=0;i<26;i++)await ok(get('/api/crm?kind=contacts&id='+ids.contacts));
  const recent=await(await ok(get(history))).text();
  const older=recent.match(/href="([^"]+)"[^>]*>Older activity/);
  assert.ok(older);const next=await(await ok(get(older[1].replaceAll('&amp;','&')))).text();
  assert.ok(next.includes(ids.companies));
  // Recovery may retain receipts but omit the token itself. Its history must stay searchable.
  const retiredToken=randomUUID();
  await sql`INSERT INTO portable_record_access_events(workspace_id,actor_id,actor_email,token_id,kind,action,record_ids)
    SELECT workspace_id,actor_id,actor_email,${retiredToken}::uuid,kind,action,record_ids FROM portable_record_access_events
    WHERE action='integration' AND kind='contacts' LIMIT 1`;
  const recovered=await(await ok(get(history+'&token='+retiredToken))).text();
  const recoveredRows=recovered.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
  assert.ok(recoveredRows?.includes(retiredToken)&&recoveredRows.includes('Integration activity'));
  assert.equal((recoveredRows.match(/<tr>/g)??[]).length,1);
  const historicalReads=await(await ok(get(history+'&token='+retiredToken+'&operation=read'))).text();
  assert.ok(historicalReads.includes('No matching access events.'));
  await verifyInvestigationFilters({get,ok,sql,history,workspaceId:workspace.owned,other});
  await verifyListAccess({get,send,other,ok,sql,workspaceId:workspace.owned,origin,headers});
  await verifyWorkItemHistory({get,send,other,ok,sql,workspaceId:workspace.owned,memberId:restricted.viewers.find(person=>person.email==='other@example.test').id});
  for(const kind of kinds){
    const id=ids[kind],path=kind==='contacts'?'/?contact='+id:'/?kind='+kind+'&record='+id;
    const page=await (await ok(get(path))).text();
    const link=page.match(/href="([^"]+)">View record access history<\/a>/)?.[1].replaceAll('&amp;','&');
    assert.equal(link,'/?view=record-access&kind='+kind+'&record='+id);
    const csvHistory=await (await ok(get(link+'&action=csv'))).text();
    assert.ok(csvHistory.includes(id)&&csvHistory.includes('owner@example.test'));
  }
  await verifyDuplicateReviewAccess({get,send,ok,sql,workspaceId:workspace.owned,other,origin});
  await verifyDismissedDuplicatePaging({get,send,ok,sql,other,workspaceId:workspace.owned});
  await verifySuggestedDuplicatePaging({get,ok,sql,workspaceId:workspace.owned});
  await verifyImportAccess({send,get,sql,ok,workspaceId:workspace.owned,other});
  await verifyAccessCsv({get,send,ok,sql,workspaceId:workspace.owned,headers,other,origin,info,auth});
}


async function verifyInvestigationFilters({get,ok,sql,history,workspaceId,other}){
  const start=Date.parse('2020-03-08T00:00:00Z'),end=Date.parse('2020-03-09T00:00:00Z');
  const who='former@example.test';
  const rows=Array.from({length:27},(_,i)=>({workspace_id:workspaceId,actor_id:'former-rep',actor_email:who,kind:'contacts',
    action:'history',occurred_at:i===0?start:end-1,record_ids:[randomUUID()]}));
  await sql`INSERT INTO portable_record_access_events ${sql([...rows,{...rows[0],occurred_at:start-1},
    {...rows[0],occurred_at:end},{...rows[0],actor_email:'someone-else@example.test'}])}`;
  const filter=history+'&action=history&email=FORMER%40example.test&from=2020-03-08&through=2020-03-08';
  const html=await (await ok(get(filter))).text();
  const ids=body=>[...body.matchAll(/<li><a href="[^"]+">([a-f0-9-]{36})<\/a><\/li>/g)].map(match=>match[1]);
  const first=ids(html);
  assert.equal(first.length,25);
  const next=html.match(/href="([^"]+)"[^>]*>Older activity/)[1].replaceAll('&amp;','&');
  const last=ids(await (await ok(get(next))).text());
  assert.equal(last.length,2);
  assert.deepEqual([...first,...last].sort(),rows.map(row=>row.record_ids[0]).sort());
  assert.match(await (await ok(get(filter,other))).text(),/No matching access events/);
  assert.match(await (await ok(get(history+'&from=2020-03-09&through=2020-03-08'))).text(),/Choose an end date/);
  assert.equal((await get(history+'&from=2020-02-30')).status,404);
}
