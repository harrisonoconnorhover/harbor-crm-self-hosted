import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import postgres from 'postgres';
import {applyPortableMigrations,portableMigrationHistory,readPortableMigrations} from '../runtime/portable-migrations.mjs';

const bundle=process.env.HARBOR_TEST_UPGRADE_BUNDLE;
const execute=promisify(execFile);

// Include duplicate rows and all original columns. New columns can acquire defaults.
// Only digests of rows cross the database connection, in bounded batches.
async function snapshot(db,tables){
  const result=new Map();
  for(const {name,columns} of tables){
    const rows=db`SELECT encode(sha256(convert_to(to_jsonb(original)::text,'UTF8')),'hex') AS digest
      FROM (SELECT ${db(columns)} FROM public.${db(name)}) original ORDER BY digest`;
    const hash=createHash('sha256');
    let count=0;
    for await(const batch of rows.cursor(256)){
      count+=batch.length;
      for(const row of batch)hash.update(row.digest);
    }
    result.set(name,{count,digest:hash.digest('hex')});
  }
  return result;
}

// Check the files that actually came from the backup through the upgraded app.
// Use a fictional viewer on the local copy so no source account or credential is needed.
async function verifyRestoredDownloads({db,manifest,viewerId,cookie,request}){
  const files=[];
  for(const entry of manifest.files){
    const [,workspace,storageContact,fileId,versionId]=entry.key.split('/');
    const [row]=await db`SELECT f.contact_id, f.revision, c.archived_at FROM contact_file_versions f
      JOIN contacts c ON (c.workspace_id,c.id)=(f.workspace_id,f.contact_id)
      WHERE f.workspace_id=${workspace} AND f.file_id=${fileId} AND f.version_id=${versionId}
        AND coalesce(f.storage_contact_id,f.contact_id)=${storageContact} AND f.revision IS NOT NULL`;
    assert.ok(row,'A restored object must map back to a committed contact file version.');
    const path='/api/record-attachments?'+new URLSearchParams({workspaceId:workspace,recordId:row.contact_id,fileId,versionId});
    files.push({workspace,versionId,fileId,path,entry,...row});
  }
  const read=path=>request(path,{headers:{cookie}});
  for(const file of files)assert.equal((await read(file.path)).status,404);
  const grants=[];
  try{
    for(const workspace of new Set(files.map(file=>file.workspace))){
      const id=randomUUID();
      await db`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role,contact_files)
        VALUES (${workspace},${viewerId},${id},'viewer',true)`;
      grants.push(id);
    }
    for(const file of files){
      const response=await read(file.path);
      if(file.archived_at){assert.equal(response.status,404);continue;}
      assert.equal(response.status,200);
      const bytes=Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length,file.entry.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),file.entry.sha256);
    }
  }finally{
    for(const id of grants)await db`DELETE FROM portable_workspace_viewers WHERE id=${id} AND viewer_id=${viewerId}`;
  }
  for(const file of files){
    assert.equal((await read(file.path)).status,404);
    const events=await db`SELECT file_revision,record_ids FROM portable_record_access_events
      WHERE workspace_id=${file.workspace} AND actor_id=${viewerId} AND action='document'
        AND file_id=${file.fileId} AND file_version_id=${file.versionId}`;
    assert.deepEqual([...events],file.archived_at?[]:[{file_revision:file.revision,record_ids:[file.contact_id]}]);
  }
  console.log('Verified private download links and attributed receipts for %d accessible versions; %d archived versions stayed private.',
    files.filter(file=>!file.archived_at).length,files.filter(file=>file.archived_at).length);
}

export async function verifyTeamUpgrade({admin,address,files,env,tenant,ownerEmail,deputyEmail,ownerObject,deputyObject,restart,login,request,json}){
  const password=randomUUID();
  await admin.unsafe("CREATE ROLE harbor_upgrade_owner LOGIN NOSUPERUSER PASSWORD '"+password+"'");
  await admin`CREATE DATABASE harbor_upgrade OWNER harbor_upgrade_owner`;
  address.username='harbor_upgrade_owner';
  address.password=password;
  address.pathname='/harbor_upgrade';
  const db=postgres(address.href,{max:1,onnotice:()=>{}});
  const {bucket,storage}=files;
  env.DATABASE_URL=address.href;
  let browser,contactTab,scheduledNotes;
  const command=(...args)=>execute(process.execPath,['scripts/portable-web.mjs',...args],{env});
  try{
    const migrations=readPortableMigrations('db/postgres/migrations');
    const manifest=JSON.parse(await readFile(join(bundle,'manifest.json'),'utf8'));
    // 0118 introduced backup administrators. 0119 is the last release before team scoping.
    assert.ok([119,120].includes(manifest.migrations?.length),'Choose a backup from migration 0118 or 0119.');
    const restoreStart=performance.now();
    await command('restore',bundle);
    const restoreMs=Math.round(performance.now()-restoreStart);
    assert.equal((await portableMigrationHistory(db,migrations)).applied,manifest.migrations.length);
    const [restoredAccess]=await db`SELECT
      EXISTS (SELECT 1 FROM login_sessions) AS sessions, EXISTS (SELECT 1 FROM portable_google_grants) AS mailbox_grants,
      EXISTS (SELECT 1 FROM portable_workspace_viewers) AS members, EXISTS (SELECT 1 FROM portable_api_tokens) AS tokens`;
    assert.deepEqual({...restoredAccess},{sessions:false,mailbox_grants:false,members:false,tokens:false});
    const baseline=migrations.slice(0,120);
    assert.equal(await applyPortableMigrations(db,baseline),'ok');

    // Restore deliberately omits live grants. Exercise an old editor appointment in its place.
    const owner=randomUUID(),deputy=randomUUID(),workspace=randomUUID(),grant=randomUUID();
    for(const [id,subject,email] of [[owner,ownerObject,ownerEmail],[deputy,deputyObject,deputyEmail]]){
      await db`INSERT INTO login_identities(id,microsoft_subject,email,created_at,updated_at)
        VALUES (${id},${tenant+':'+subject},${email},1,1)`;
    }
    await db`INSERT INTO private_workspaces(id,owner_id) VALUES (${workspace},${owner})`;
    await db`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role,backup_admin,contact_files,scheduled_notes)
      VALUES (${workspace},${deputy},${grant},'editor',true,true,true)`;
    const contact=randomUUID(),fileId=randomUUID(),versionId=randomUUID();
    const bytes=Buffer.from('Fictional renewal proposal for the upgrade rehearsal.');
    const data={name:'Upgrade rehearsal contact',email:'renewal@example.test'};
    await db`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      VALUES (${workspace},${contact},1,${db.json(data)},now(),now())`;
    await db`INSERT INTO contact_events(workspace_id,contact_id,revision,actor_id,data,occurred_at)
      VALUES (${workspace},${contact},1,${owner},${db.json(data)},now())`;
    await db`INSERT INTO contact_file_versions(workspace_id,contact_id,file_id,version_id,revision,name,size,sha256,created_at,actor_id)
      VALUES (${workspace},${contact},${fileId},${versionId},1,'Renewal.txt',${bytes.length},
        ${createHash('sha256').update(bytes).digest('hex')},now(),${owner})`;
    await storage.send(new PutObjectCommand({Bucket:bucket,Key:['contact-files',workspace,contact,fileId,versionId].join('/'),Body:bytes}));

    // Represent a deputy's admitted Note interrupted by shutdown, and a due provider action.
    // Both are deliberately written against the pre-upgrade schema.
    const note=randomUUID(),external=randomUUID(),started=Date.now()-60_000;
    const body='Follow up on the fictional renewal.';
    await db`INSERT INTO portable_jobs
      (workspace_id,id,contact_id,actor_id,authorized_owner_id,kind,body,scheduled_for,available_at,created_at,status,attempts,lease_token,lease_until)
      VALUES (${workspace},${note},${contact},${deputy},${owner},'note',${body},${started},${started},${started},'running',1,${randomUUID()},${started+30000}),
             (${workspace},${external},${contact},${owner},NULL,'external','Fictional provider action',${started},${started},${started},'queued',0,NULL,NULL)`;
    await db`INSERT INTO portable_job_attempts(workspace_id,job_id,number,started_at)
      VALUES (${workspace},${note},1,${started})`;
    const notesPass=()=>command('worker','--once','--notes-only');
    const tables=await db`SELECT t.table_name AS name,array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
      FROM information_schema.tables t JOIN information_schema.columns c USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' GROUP BY t.table_name ORDER BY t.table_name`;
    const before=await snapshot(db,tables);
    await assert.rejects(notesPass(),e=>e.code===1&&e.stderr.includes('migration_required'));
    // Simulate a reader left open during the upgrade. Migration 0122 alters this table after 0120 has run.
    const oldLedger=await portableMigrationHistory(db,baseline);
    await db.begin(async tx=>{
      await tx`LOCK TABLE portable_workspace_viewers IN ACCESS SHARE MODE`;
      await assert.rejects(execute(process.execPath,['scripts/portable-web.mjs','migrate'],{env,timeout:20000}),
        e=>e.code===1&&e.stderr.includes('A database lock blocked the upgrade'));
      assert.equal((await tx`SELECT to_regclass('public.portable_marketing_audience_accounts') AS added`)[0].added,null);
      assert.deepEqual(await portableMigrationHistory(tx,baseline),oldLedger);
    });
    assert.deepEqual(await snapshot(db,tables),before);
    const migrationStart=performance.now();
    await command('migrate');
    const migrationMs=Math.round(performance.now()-migrationStart);
    const history=await portableMigrationHistory(db,migrations);
    assert.equal(history.status,'ok');
    assert.equal(history.applied,migrations.length);
    assert.equal((await portableMigrationHistory(db,baseline)).status,'newer_release_required');
    assert.deepEqual(await snapshot(db,tables),before);
    const [access]=await db`SELECT view_scope,edit_scope FROM portable_workspace_viewers WHERE id=${grant}`;
    assert.deepEqual({...access},{view_scope:'all',edit_scope:'all'});
    await command('migrate');
    assert.deepEqual((await portableMigrationHistory(db,migrations)).receipts,history.receipts);
    for(const file of manifest.files){
      const object=await storage.send(new GetObjectCommand({Bucket:bucket,Key:file.key}));
      const bytes=await object.Body.transformToByteArray();
      assert.equal(bytes.length,file.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
    }
    // Exercise the packaged worker on the migrated store, including its real retry delay.
    await notesPass();
    const [retry]=await db`SELECT available_at,status,issue FROM portable_jobs WHERE workspace_id=${workspace} AND id=${note}`;
    assert.equal(retry.status,'queued');
    assert.equal(retry.issue,'lease_expired');
    await delay(Math.max(0,Number(retry.available_at)-Date.now()+10));
    await notesPass();
    await notesPass(); // A replacement process must leave the finished Note alone.
    const completed=await db`SELECT n.body,j.actor_id,j.status,j.attempts FROM portable_notes n
      JOIN portable_jobs j ON (j.workspace_id,j.id)=(n.workspace_id,n.job_id)
      WHERE n.workspace_id=${workspace} AND n.job_id=${note}`;
    assert.deepEqual([...completed],[{body,actor_id:deputy,status:'succeeded',attempts:2}]);
    const attempts=await db`SELECT number,outcome FROM portable_job_attempts
      WHERE workspace_id=${workspace} AND job_id=${note} ORDER BY number`;
    assert.deepEqual([...attempts],[{number:1,outcome:'lease_expired'},{number:2,outcome:'succeeded'}]);
    const [untouched]=await db`SELECT status,attempts FROM portable_jobs WHERE workspace_id=${workspace} AND id=${external}`;
    assert.deepEqual({...untouched},{status:'queued',attempts:0});
    await restart();
    const ownerCookie=await login('microsoft',{oid:ownerObject});
    const deputyCookie=await login('microsoft',{oid:deputyObject});
    const contactPath='/api/crm?'+new URLSearchParams({id:contact,workspaceId:workspace});
    const attachment='/api/record-attachments?'+new URLSearchParams({recordId:contact,fileId,versionId,workspaceId:workspace});
    const read=path=>request(path,{headers:{cookie:deputyCookie}});
    const noteHistoryPath='/api/background-jobs?'+new URLSearchParams({recordId:contact,workspaceId:workspace});
    const noteHistory=await read(noteHistoryPath);
    assert.equal(noteHistory.status,200);
    const {items}=await noteHistory.json();
    assert.deepEqual(items.map(item=>item.id),[note]);
    assert.equal(items[0].body,body);
    assert.equal(items[0].actorEmail,deputyEmail);
    assert.deepEqual(items[0].receipts.map(r=>r.outcome),['lease_expired','succeeded']);
    await verifyRestoredDownloads({db,manifest,viewerId:owner,cookie:ownerCookie,request});
    const recordPage='/?'+new URLSearchParams({contact,workspaceId:workspace});
    if(process.env.HARBOR_TEST_PLAYWRIGHT){
      const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
      browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
      contactTab=await browser.newPage({viewport:{width:390,height:844}});
      const [name,value]=deputyCookie.split('=');
      await contactTab.context().addCookies([{name,value,url:env.HARBOR_LOGIN_ORIGIN}]);
      await contactTab.goto(new URL(recordPage+'#portable-contact-jobs',env.HARBOR_LOGIN_ORIGIN).href);
      scheduledNotes=contactTab.getByRole('region',{name:'Scheduled notes'});
      const item=scheduledNotes.getByRole('listitem').filter({hasText:body}).first();
      await item.getByText('Run details',{exact:true}).click();
      await item.getByText('Scheduled by '+deputyEmail,{exact:true}).waitFor();
    }
    const page=await read(recordPage);
    assert.equal(page.status,200);
    assert.ok((await page.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').includes(data.name));
    const existing=await read(contactPath);
    assert.equal(existing.status,200);
    assert.equal((await existing.json()).data.name,data.name);
    const download=await read(attachment);
    assert.equal(download.status,200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
    const editPath='/api/crm?'+new URLSearchParams({workspaceId:workspace,grantId:grant});
    const edit={action:'save',kind:'contacts',id:contact,expectedRevision:1,data:{...data,name:'Renewal reviewed'}};
    assert.equal((await json(editPath,edit,deputyCookie)).status,200);
    assert.equal((await (await read(contactPath)).json()).data.name,'Renewal reviewed');
    const [event]=await db`SELECT actor_id FROM contact_events WHERE workspace_id=${workspace} AND contact_id=${contact} AND revision=2`;
    assert.equal(event.actor_id,deputy);
    let currentGrant=grant;
    async function changeGrant(change){
      const response=await json('/api/workspaces',{...change,id:currentGrant},ownerCookie);
      assert.equal(response.status,200);
      const member=(await response.json()).viewers.find(person=>person.email===deputyEmail);
      currentGrant=member.id;
    }
    await changeGrant({action:'backup_admin',enabled:false});
    await changeGrant({action:'record_scope',viewScope:'owned',editScope:'owned'});
    for(const path of [contactPath,attachment,noteHistoryPath])assert.equal((await read(path)).status,404);
    const assigned=await json('/api/crm',{...edit,expectedRevision:2,assigneeId:deputy},ownerCookie);
    assert.equal(assigned.status,200);
    assert.equal((await read(contactPath)).status,200);
    assert.equal((await read(attachment)).status,200);
    const currentEdit='/api/crm?'+new URLSearchParams({workspaceId:workspace,grantId:currentGrant});
    assert.equal((await json('/api/workspaces',{action:'revoke',id:currentGrant},ownerCookie)).status,200);
    for(const path of [contactPath,attachment,noteHistoryPath])assert.equal((await read(path)).status,401);
    assert.equal((await json(currentEdit,{...edit,expectedRevision:3},deputyCookie)).status,401);
    if(scheduledNotes){
      await scheduledNotes.getByRole('button',{name:'Refresh scheduled notes'}).click();
      await scheduledNotes.getByText('You no longer have access to these scheduled notes.').waitFor();
      assert.equal(await scheduledNotes.getByRole('listitem').count(),0);
      assert.equal(await scheduledNotes.getByLabel('Note',{exact:true}).count(),0);
      await scheduledNotes.getByRole('button',{name:'Reload contact'}).click();
      await contactTab.waitForURL(url=>url.pathname==='/auth/sign-in');
    }
    const signedOut=await read(recordPage);
    assert.equal(signedOut.status,307);
    assert.equal(new URL(signedOut.headers.get('location'),env.HARBOR_LOGIN_ORIGIN).pathname,'/auth/sign-in');
    const retained=await request('/api/crm?id='+contact,{headers:{cookie:ownerCookie}});
    assert.equal(retained.status,200);
    assert.equal((await retained.json()).revision,3);
    console.log('Local database and file restore: %d ms. First release migration command: %d ms.',restoreMs,migrationMs);
    console.log('Verified %d old tables, %d rows, %d attachment versions and %d migrations from 0119.',
      tables.length,[...before.values()].reduce((total,table)=>total+table.count,0),manifest.files.length,migrations.length-baseline.length);
  }finally{try{await browser?.close();}finally{await db.end();}}
}
