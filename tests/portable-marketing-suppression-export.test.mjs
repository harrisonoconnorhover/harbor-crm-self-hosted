import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {tsImport} from 'tsx/esm/api';
import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {applyPortableMigrations,readPortableMigrations} from '../runtime/portable-migrations.mjs';

const {exportSalesforceOptOuts}=await tsImport('../db/postgres/marketing-suppression-export.ts',import.meta.url);

test('An existing suppression export or symlink is always preserved',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'harbor-optout-existing-')),target=join(dir,'original'),alias=join(dir,'link');
  try{
    await writeFile(target,'keep');await symlink(target,alias);
    await assert.rejects(exportSalesforceOptOuts({},crypto.randomUUID(),target),/new file/);
    await assert.rejects(exportSalesforceOptOuts({},crypto.randomUUID(),alias),/new file/);
    assert.equal(await readFile(target,'utf8'),'keep');
  }finally{await rm(dir,{recursive:true,force:true});}
});

const sourceDb=process.env.HARBOR_TEST_POSTGRES_URL;
test('Salesforce opt-out export reads distinct Contact IDs across pages from one fresh generation, then publishes exclusively',
  {skip:!sourceDb,timeout:65000},async()=>{
    const url=new URL(sourceDb);
    assert.ok(url.hostname==='127.0.0.1'&&/^\/harbor_identity_test(?:_[a-z0-9]+)?$/.test(url.pathname));
    const admin=postgres(url.href,{max:1,onnotice:()=>{}}),name='harbor_optout_exit_'+crypto.randomUUID().replaceAll('-','');
    const dir=await mkdtemp(join(tmpdir(),'harbor-optout-exit-'));
    let client,created=false;
    try{
      await admin.unsafe('CREATE DATABASE '+name);created=true;url.pathname='/'+name;
      client=postgres(url.href,{max:4,onnotice:()=>{}});const db=drizzle(client);
      assert.equal(await applyPortableMigrations(client,readPortableMigrations(resolve('db/postgres/migrations'))),'ok');
      const ws=crypto.randomUUID(),other=crypto.randomUUID(),gen=crypto.randomUUID(),old=crypto.randomUUID();
      for(const workspace of [ws,other]){
        await client`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
          VALUES(${workspace},${workspace},${workspace+'@example.test'},0,0)`;
        await client`INSERT INTO private_workspaces(id,owner_id) VALUES(${workspace},${workspace})`;
        await client`INSERT INTO portable_marketing_audience_sync(workspace_id,generation,source_key,state,mapping,started_at,progressed_at,completed_at)
          VALUES(${workspace},${gen},'fixture-source','ready','{"consentField":"Marketing__c","accountFields":[]}',now(),now(),now())`;
      }
      await client`INSERT INTO portable_marketing_audience_contacts(workspace_id,id,generation,email,eligible)
        SELECT ${ws}::uuid,'003'||lpad(n::text,15,'0'),${gen}::uuid,CASE WHEN n%2=0 THEN 'first@example.test'
          ELSE 'second@example.test' END,n%2=0 FROM generate_series(1,1103) n`;
      await client`INSERT INTO portable_marketing_audience_contacts(workspace_id,id,generation,email,eligible) VALUES
        (${ws},'003000000000099980',${old},'first@example.test',false),
        (${ws},'003000000000099981',${gen},'manual@example.test',false),
        (${ws},'003000000000099982',${gen},'unblocked@example.test',true),
        (${other},'003000000000099983',${gen},'first@example.test',true)`;
      await client`INSERT INTO portable_email_suppressions(workspace_id,id,email,created_at,recipient_opted_out_at) VALUES
        (${ws},gen_random_uuid(),'first@example.test',now(),now()),(${ws},gen_random_uuid(),'second@example.test',now(),now()),
        (${ws},gen_random_uuid(),'unmatched@example.test',now(),now()),(${ws},gen_random_uuid(),'manual@example.test',now(),NULL),
        (${other},gen_random_uuid(),'unblocked@example.test',now(),now())`;
      const target=join(dir,'updates.csv');
      const attempts=await Promise.allSettled([exportSalesforceOptOuts(db,ws,target),exportSalesforceOptOuts(db,ws,target)]);
      const success=attempts.filter(x=>x.status==='fulfilled');
      assert.equal(success.length,1);
      assert.match(attempts.find(x=>x.status==='rejected').reason.message,/new file/);
      const {snapshot,...counts}=success[0].value;assert.match(snapshot,/Z$/);
      assert.deepEqual(counts,{workspaceId:ws,generation:gen,confirmedAddresses:3,matchedAddresses:2,unmatchedAddresses:1,contactRows:1103});
      assert.equal((await stat(target)).mode&0o777,0o600);
      const lines=(await readFile(target,'utf8')).trimEnd().split('\r\n');
      assert.equal(lines.shift(),'Id,HasOptedOutOfEmail');
      assert.deepEqual(lines,Array.from({length:1103},(_,i)=>'003'+String(i+1).padStart(15,'0')+',TRUE'));
      await client`UPDATE portable_marketing_audience_sync SET started_at=now()-interval '25 hours' WHERE workspace_id=${ws}`;
      await assert.rejects(exportSalesforceOptOuts(db,ws,join(dir,'stale.csv')),/Refresh/);
      await client`UPDATE portable_marketing_audience_sync SET started_at=now(),state='syncing' WHERE workspace_id=${ws}`;
      await assert.rejects(exportSalesforceOptOuts(db,ws,join(dir,'partial.csv')),/Refresh/);
      await client`UPDATE portable_marketing_audience_sync SET state='ready' WHERE workspace_id=${ws}`;
      await client`INSERT INTO portable_marketing_audience_contacts(workspace_id,id,generation,email,eligible)
        VALUES(${ws},'invalid-contact-id',${gen},'first@example.test',false)`;
      await assert.rejects(exportSalesforceOptOuts(db,ws,join(dir,'bad.csv')),/invalid Salesforce Contact ID/);
      assert.deepEqual(await readdir(dir),['updates.csv']);
    }finally{
      await rm(dir,{recursive:true,force:true});await client?.end({timeout:3});
      try{if(created)await admin.unsafe('DROP DATABASE '+name);}finally{await admin.end({timeout:3});}
    }
  });
