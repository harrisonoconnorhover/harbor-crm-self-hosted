import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import 'tsx/esm';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {applyPortableMigrations,readPortableMigrations} from '../runtime/portable-migrations.mjs';
const {salesSequenceCommand,salesSequenceQuery}=await import('../lib/portable-sales-sequences.ts');
const {writeSalesSequences,readSalesSequences}=await import('../db/postgres/sales-sequence-store.ts');

const email={type:'email',subject:'A fictional introduction',body:'Hi!\n\n  A plain note.\n',delayDays:2,id:randomUUID()};
const call={type:'task',taskType:'Call',title:'Call the contact',notes:'Ask about timing.',delayDays:1,id:randomUUID()};
const definition={action:'save',id:randomUUID(),expectedRevision:0,name:'First contact',steps:[email,call]};
test('sequence definitions use ordinary Gmail and task validation, and keep authored order and plain text',()=>{
  assert.deepEqual(salesSequenceCommand.parse(definition),definition);
  for(const steps of [[],Array(21).fill(call),[call,call],[{...email,subject:'Injected\r\nHeader'}],
    [{...email,body:'{{contact.name}}'}],[{...email,body:'a'.repeat(8001)}],[{...call,title:'t'.repeat(161)}],
    [{...email,timing:{dueAfterMinutes:10}}],[{...call,timing:{dueAfterMinutes:0,reminderMinutes:5}}],
    [{...call,timing:{dueAfterMinutes:5.5}}],[{...call,timing:{dueAfterMinutes:-1}}],
    [{...call,timing:{dueAfterMinutes:30,reminderMinutes:10}}],[{...call,delayDays:-1}],[{...call,taskType:'Other'}],[{...call,notes:'n'.repeat(2001)}]]){
    assert.equal(salesSequenceCommand.safeParse({...definition,steps}).success,false);
  }
  assert.ok(salesSequenceCommand.safeParse({...definition,steps:[{...call,taskType:'LinkedIn'}]}).success);
  assert.equal(salesSequenceQuery.safeParse({view:'assignees',page:'1'}).success,true);
  assert.equal(salesSequenceQuery.safeParse({view:'assignees',after:randomUUID()}).success,false);
  assert.equal(salesSequenceQuery.safeParse({view:'enrollments',workspaceId:randomUUID()}).success,false);
});

const database=process.env.HARBOR_TEST_POSTGRES_URL;
test('PostgreSQL isolates owners, snapshots enrollments, serializes duplicate requests and retains stopped history',
  {skip:!database,timeout:60000},async()=>{
    const url=new URL(database);
    assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/harbor_identity_test(?:_[a-z0-9]+)?$/);
    const admin=postgres(url.href,{max:1,onnotice(){}}),dbName='harbor_sequences_'+randomUUID().replaceAll('-','');
    let client;
    try{
      await admin`CREATE DATABASE ${admin(dbName)}`;url.pathname='/'+dbName;
      client=postgres(url.href,{max:5,onnotice(){}});const db=drizzle(client);
      await applyPortableMigrations(client,readPortableMigrations(fileURLToPath(new URL('../db/postgres/migrations',import.meta.url))));
      const owner='sales-sequence-owner',member='sales-sequence-rep',foreign='another-sales-owner';
      const ws=randomUUID(),contact=randomUUID(),foreignContact=randomUUID(),otherWs=randomUUID();
      for(const actor of [owner,member,foreign])await client`INSERT INTO login_identities(id,google_subject,email,full_name,created_at,updated_at)
        VALUES(${actor},${actor},${actor+'@example.test'},${actor},0,0)`;
      for(const [actor,id,record] of [[owner,ws,contact],[foreign,otherWs,foreignContact]]){
        await client`INSERT INTO private_workspaces(id,owner_id) VALUES(${id},${actor})`;
        await client`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
          VALUES(${id},${record},1,'{"name":"Fictional prospect","email":"prospect@example.test"}',now(),now())`;
      }
      const sender=owner+'@example.test';
      const identity=userId=>({userId,email:userId+'@example.test'});
      const write=(command,actor=owner,from=sender)=>writeSalesSequences(db,identity(actor),salesSequenceCommand.parse(command),from);
      const read=(query,actor=owner)=>readSalesSequences(db,identity(actor),salesSequenceQuery.parse(query));
      const status=code=>error=>error.status===code;
      const {sequence}=await write(definition);
      assert.equal(sequence.revision,1);assert.deepEqual(sequence.steps,[email,call]);
      assert.deepEqual((await write(definition)).sequence,sequence);
      assert.deepEqual(await read({sequenceId:sequence.id}),{sequence});
      assert.equal((await read({})).items[0].stepCount,2);
      await assert.rejects(read({sequenceId:sequence.id},foreign),status(404));
      assert.deepEqual(await read({},foreign),{items:[],next:null});
      await assert.rejects(write({...definition,name:'Other draft'}),status(409));
      const command={action:'enroll',id:randomUUID(),sequenceId:sequence.id,expectedRevision:1,contactId:contact,
        assigneeId:member,recipient:'prospect@example.test'};
      await assert.rejects(write(command),status(409));
      await client`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role) VALUES(${ws},${member},gen_random_uuid(),'editor')`;
      assert.deepEqual((await read({view:'assignees'})).items.map(row=>row.id),[owner,member]);
      await assert.rejects(write({...command,contactId:foreignContact}),status(404));
      await assert.rejects(write(command,owner,null),status(409));
      await assert.rejects(write(command,owner,'elsewhere@example.test'),status(409));
      await assert.rejects(write({...command,recipient:'old@example.test'}),status(409));
      await client`INSERT INTO portable_email_suppressions(workspace_id,id,email,created_at)
        VALUES(${ws},gen_random_uuid(),'prospect@example.test',now())`;
      await assert.rejects(write(command),status(409));
      await client`DELETE FROM portable_email_suppressions WHERE workspace_id=${ws}`;
      const [first,replayed]=await Promise.all([write(command),write(command)]);
      assert.deepEqual(first,replayed);
      assert.deepEqual(await write({...command,startStepId:email.id}),first);
      assert.deepEqual(first.steps.map(row=>row.definition),sequence.steps);
      assert.equal(new Set(first.steps.map(row=>row.id)).size,2);
      assert.equal(first.enrollment.activeActivation,true);
      assert.equal(first.enrollment.sender,sender);assert.equal(first.enrollment.assigneeLabel,member);
      assert.deepEqual(first.steps.map(row=>[row.state,row.dueAt]),[['ready',first.enrollment.createdAt+2*86400000],['waiting',null]]);
      await assert.rejects(write({...command,id:randomUUID()}),status(409));
      await assert.rejects(write({...command,assigneeId:owner}),status(409));
      await assert.rejects(read({enrollmentId:command.id},foreign),status(404));
      await assert.rejects(read({contactId:contact},member),status(404));
      await assert.rejects(write({action:'stop',id:command.id},foreign),status(404));
      await write({...definition,expectedRevision:1,name:'Revised task sequence',steps:[call]});
      await client`UPDATE contacts SET data='{"name":"New name","email":"changed@example.test"}' WHERE workspace_id=${ws} AND id=${contact}`;
      assert.deepEqual(await write(command),first);
      assert.deepEqual(await read({enrollmentId:command.id}),first);
      assert.deepEqual((await read({contactId:contact})).items,[first.enrollment]);
      await assert.rejects(write({...command,id:randomUUID()}),status(409));
      const stopped=await write({action:'stop',id:command.id});
      assert.equal(stopped.enrollment.activeActivation,false);assert.equal(stopped.enrollment.state,'stopped');
      assert.ok(stopped.steps.every(row=>row.state==='stopped'&&row.finishedAt!==null));
      assert.deepEqual(await write({action:'stop',id:command.id}),stopped);
      const fresh=await write({...command,id:randomUUID(),expectedRevision:2,recipient:null},owner,null);
      assert.equal(fresh.enrollment.sequenceName,'Revised task sequence');assert.equal(fresh.enrollment.contactName,'New name');
      assert.notEqual(fresh.steps[0].id,first.steps[1].id);
      assert.equal((await read({view:'enrollments'})).items.length,2);
      await write({action:'stop',id:fresh.enrollment.id});
      for(let i=0;i<26;i++){
        const id=randomUUID();
        await write({...command,id,expectedRevision:2,recipient:null},owner,null);
        await write({action:'stop',id});
      }
      await client`UPDATE portable_sales_enrollments SET created_at=100 WHERE workspace_id=${ws} AND state='stopped'`;
      const latest=(await client`SELECT id FROM portable_sales_enrollments WHERE workspace_id=${ws} ORDER BY id LIMIT 1`)[0].id;
      await client`UPDATE portable_sales_enrollments SET created_at=200 WHERE workspace_id=${ws} AND id=${latest}`;
      const filter={view:'enrollments',state:'stopped'};
      const expected=await client`SELECT id FROM portable_sales_enrollments WHERE workspace_id=${ws} AND state='stopped' ORDER BY created_at DESC,id DESC`;
      // Put a different contact just beyond the returned page.
      const nextContact=randomUUID();
      await client`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
        VALUES(${ws},${nextContact},1,'{"name":"Later page"}',now(),now())`;
      await client`UPDATE portable_sales_enrollments SET contact_id=${nextContact} WHERE workspace_id=${ws} AND id=${expected[25].id}`;
      const previewIds=async()=>(await client`SELECT id,record_ids FROM portable_record_access_events
        WHERE workspace_id=${ws} AND kind='contacts' AND action='related'`);
      const previous=new Set((await previewIds()).map(row=>row.id));
      const firstPage=await read(filter);
      const firstReceipts=(await previewIds()).filter(row=>!previous.has(row.id));
      assert.deepEqual(firstReceipts.map(row=>[...row.record_ids]),[[contact]]);
      assert.equal(firstPage.items.length,25);
      assert.equal(firstPage.items[0].id,latest);
      // A cursor remains usable if the preceding row changes queue between requests.
      await client`UPDATE portable_sales_enrollments SET state='completed' WHERE workspace_id=${ws} AND id=${firstPage.next}`;
      const nextPage=await read({...filter,after:firstPage.next});
      const nextReceipts=(await previewIds()).filter(row=>!previous.has(row.id)&&row.id!==firstReceipts[0].id);
      assert.deepEqual(nextReceipts.map(row=>[...row.record_ids]),[[...new Set(nextPage.items.map(row=>row.contactId))]]);
      assert.ok(nextReceipts[0].record_ids.includes(nextContact));
      assert.equal(nextPage.next,null);
      assert.deepEqual([...firstPage.items,...nextPage.items].map(row=>row.id),expected.map(row=>row.id));
      assert.deepEqual((await read(filter,foreign)).items,[]);
      await assert.rejects(read({...filter,after:randomUUID()}),status(404));
      assert.equal(salesSequenceQuery.safeParse({contactId:contact,state:'attention'}).success,false);
      const compete=()=>write({...command,id:randomUUID(),expectedRevision:2,recipient:null},owner,null);
      const race=await Promise.allSettled([compete(),compete()]);
      assert.equal(race.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(race.find(result=>result.status==='rejected').reason.status,409);
      await client`INSERT INTO portable_sales_sequences(workspace_id,id,name,revision,steps,created_at,updated_at)
        SELECT ${ws},gen_random_uuid(), 'Training sequence ' || n, 1,${JSON.stringify([call])}::jsonb,0,0 FROM generate_series(1,26) n`;
      const head=await read({}),tail=await read({after:head.next});
      assert.equal(head.items.length,25);assert.equal(tail.items.length,2);assert.equal(tail.next,null);
      assert.equal(new Set([...head.items,...tail.items].map(row=>row.id)).size,27);
      // A manager can take a child team's contact. A team move between
      // opening the assignee picker and confirming enrollment takes effect immediately.
      const sales=randomUUID(),pod=randomUUID(),prospect=randomUUID();
      await client`INSERT INTO portable_workspace_teams(workspace_id,id,name,name_key,parent_id)
        VALUES(${ws},${sales},'Sales','sales',NULL),(${ws},${pod},'Inbound','inbound',${sales})`;
      await client`UPDATE portable_workspace_viewers SET team_id=${sales},view_scope='team',edit_scope='team'
        WHERE workspace_id=${ws} AND viewer_id=${member}`;
      await client`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role,team_id)
        VALUES(${ws},${foreign},gen_random_uuid(),'editor',${pod})`;
      await client`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
        VALUES(${ws},${prospect},1,${JSON.stringify({name:'Inbound lead',recordOwner:{userId:foreign,workspaceId:ws,label:'Inbound rep'}})}::jsonb,now(),now())`;
      const offered=async()=>(await read({view:'assignees',contactId:prospect})).items.some(row=>row.id===member);
      assert.ok(await offered());
      await client`UPDATE portable_workspace_teams SET parent_id=NULL WHERE workspace_id=${ws} AND id=${pod}`;
      assert.equal(await offered(),false);
      const managerEnrollment={...command,id:randomUUID(),expectedRevision:2,contactId:prospect,recipient:null};
      await assert.rejects(write(managerEnrollment),status(409));
      await client`UPDATE portable_workspace_teams SET parent_id=${sales} WHERE workspace_id=${ws} AND id=${pod}`;
      assert.equal((await write(managerEnrollment)).enrollment.assigneeId,member);
      const handoffSequence={...definition,id:randomUUID()};
      await write(handoffSequence);
      const handoff={...command,id:randomUUID(),sequenceId:handoffSequence.id,assigneeId:owner,recipient:null,startStepId:call.id};
      await assert.rejects(write({...handoff,startStepId:randomUUID()},owner,null),status(409));
      const receipt=await write(handoff,owner,null);
      assert.deepEqual(receipt.steps.map(row=>[row.position,row.definition.id]),[[1,call.id]]);
      await write({...handoffSequence,expectedRevision:1,steps:[email]});
      assert.deepEqual(await write(handoff,owner,null),receipt);
      for(const changed of [email.id,undefined])await assert.rejects(write({...handoff,startStepId:changed},owner,null),status(409));
      // Ownership is checked afresh, even when a previous owner knows every ID.
      await client`DELETE FROM portable_workspace_viewers WHERE workspace_id=${ws} AND viewer_id=${member}`;
      await client`UPDATE private_workspaces SET owner_id=${member} WHERE id=${ws}`;
      await assert.rejects(read({enrollmentId:command.id},owner),status(404));
      await assert.rejects(write({action:'stop',id:command.id},owner),status(404));
      assert.equal((await read({enrollmentId:command.id},member)).enrollment.actorId,owner);
    }finally{
      await client?.end();try{await admin`DROP DATABASE IF EXISTS ${admin(dbName)}`;}finally{await admin.end();}
    }
  });
