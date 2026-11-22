import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {tsImport} from 'tsx/esm/api';
import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {applyPortableMigrations,readPortableMigrations} from '../runtime/portable-migrations.mjs';

const {importLegacySuppressions}=await tsImport('../db/postgres/marketing-suppression-import.ts',import.meta.url);
const {listEmailSuppressions}=await tsImport('../db/postgres/email-suppression-store.ts',import.meta.url);
const sourceDb=process.env.HARBOR_TEST_POSTGRES_URL;

async function verifySuppressionSearch(client,workspace,other,t){
  const statements=[];
  const db=drizzle(client,{logger:{logQuery:(query,params)=>statements.push({query,params})}});
  const search=(query,after='')=>listEmailSuppressions(db,workspace,query,after);
  await client`ANALYZE portable_email_suppressions`;
  const result=await search('SON-30999@EXAMPLE');
  assert.deepEqual(result.results.map(row=>row.email),['person-30999@example.test']);
  assert.equal(result.total,1);
  assert.ok(result.results[0].recipientOptedOutAt);
  const reads=statements.filter(({query})=>query.includes('from "portable_email_suppressions"'));
  assert.equal(reads.length,2);
  const plans=[];
  for(const {query,params} of reads){
    const [row]=await client.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+query,params);
    const [plan]=row['QUERY PLAN'];
    t.diagnostic('Selective suppression '+(query.includes('count(')?'count':'page')+': '+plan['Execution Time']+
      ' ms, '+plan.Plan['Shared Hit Blocks']+' cached blocks');
    plans.push(JSON.stringify(plan.Plan));
  }
  const first=await search('person-30'),next=await search('person-30',first.next);
  assert.equal(first.results.length,25);
  assert.equal(next.results.length,25);
  assert.equal(first.total,next.total);
  assert.equal(new Set([...first.results,...next.results].map(row=>row.email)).size,50);

  const special='billing_%+trial@example.test';
  await client`INSERT INTO portable_email_suppressions(workspace_id,id,email,created_at) VALUES
    (${workspace},${randomUUID()},${special},now()),(${workspace},${randomUUID()},'billingax+trial@example.test',now()),
    (${other},${randomUUID()},${special},now())`;
  for(const query of ['BILLING_%','_%','%','_']){
    const found=await search(query);
    assert.deepEqual(found.results.map(row=>row.email),[special]);assert.equal(found.total,1);
  }
  assert.equal((await search('billing\\')).total,0);
  assert.ok(plans.every(plan=>plan.includes('portable_suppression_email_search')),'Both selective reads should use the address search index');
}

test('Refuses an invalid suppression approval digest before opening any file',async()=>{
  await assert.rejects(importLegacySuppressions({},crypto.randomUUID(),'unused','not-a-sha256'),/SHA-256/);
});

test('A legacy suppression export previews and atomically imports 31,000 distinct addresses to one workspace',
  {skip:!sourceDb,timeout:100_000},async t=>{
    const url=new URL(sourceDb);
    assert.ok(url.hostname==='127.0.0.1'&&/^\/harbor_identity_test(?:_[a-z0-9]+)?$/.test(url.pathname));
    const admin=postgres(url.href,{max:1,onnotice:()=>{}}),name='harbor_suppress_'+crypto.randomUUID().replaceAll('-','');
    const folder=await mkdtemp(join(tmpdir(),'harbor-legacy-optouts-')),file=join(folder,'unsubscribed.csv');
    let client,created=false;
    try{
      await admin.unsafe('CREATE DATABASE '+name);created=true;url.pathname='/'+name;
      client=postgres(url.href,{max:2,onnotice:()=>{}});
      const db=drizzle(client);
      assert.equal(await applyPortableMigrations(client,readPortableMigrations(resolve('db/postgres/migrations'))),'ok');
      const workspace=crypto.randomUUID(),other=crypto.randomUUID();
      for(const id of [workspace,other]){
        await client`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
          VALUES(${id},${id},${id+'@example.test'},0,0)`;
        await client`INSERT INTO private_workspaces(id,owner_id) VALUES(${id},${id})`;
      }
      const manualId=crypto.randomUUID(),permanentId=crypto.randomUUID();
      await client`INSERT INTO portable_email_suppressions(workspace_id,id,email,created_at,recipient_opted_out_at) VALUES
        (${workspace},${manualId},'person-0@example.test','2024-02-01',NULL),
        (${workspace},${permanentId},'person-1@example.test','2024-02-01','2024-02-02')`;
      const header='\uFEFF"Export note","Email","Contact ID"\r\n';
      const content=header+Array.from({length:31000},(_,n)=>
        `"${n%9===0?'Already opted out,\r\nhad ""legacy"" updates 🗂':'Unsubscribed'}","Person-${n}@Example.Test",${n}\r\n`
      ).join('')+'"Duplicate","PERSON-2@EXAMPLE.TEST",31000\r\n';
      await writeFile(file,content);
      const sha256=createHash('sha256').update(content).digest('hex');
      const count=async workspaceId=>(await client`SELECT count(*)::int n FROM portable_email_suppressions
        WHERE workspace_id=${workspaceId} AND recipient_opted_out_at IS NOT NULL`)[0].n;
      const begin=performance.now(),preview=await importLegacySuppressions(db,workspace,file);
      assert.deepEqual(preview,{mode:'preview',workspaceId:workspace,sha256,rows:31001,uniqueAddresses:31000,alreadyOptedOut:1,newOptOuts:30999});
      assert.equal(await count(workspace),1);
      await writeFile(file,content+'"Additional","last@example.test",31001\r\n');
      await assert.rejects(importLegacySuppressions(db,workspace,file,sha256),/CSV changed/);
      assert.equal(await count(workspace),1);
      await writeFile(file,content+'"Missing"," ",31001\r\n');
      await assert.rejects(importLegacySuppressions(db,workspace,file,sha256),/Invalid email address in suppression CSV record 31003/);
      assert.equal(await count(workspace),1);
      await writeFile(file,content);
      assert.deepEqual(await importLegacySuppressions(db,workspace,file,sha256),{...preview,mode:'applied'});
      const duplicate=await importLegacySuppressions(db,workspace,file,sha256);
      assert.equal(duplicate.newOptOuts,0);assert.equal(duplicate.alreadyOptedOut,31000);
      assert.equal(await count(workspace),31000);assert.equal(await count(other),0);
      const [original]=await client`SELECT id,to_char(recipient_opted_out_at,'YYYY-MM-DD') AS opted FROM portable_email_suppressions
        WHERE workspace_id=${workspace} AND email='person-1@example.test'`;
      assert.deepEqual([original.id,original.opted],[permanentId,'2024-02-02']);
      const [promoted]=await client`SELECT id,to_char(created_at,'YYYY-MM-DD') AS created FROM portable_email_suppressions
        WHERE workspace_id=${workspace} AND email='person-0@example.test'`;
      assert.deepEqual([promoted.id,promoted.created],[manualId,'2024-02-01']);
      await verifySuppressionSearch(client,workspace,other,t);
      await writeFile(file,'Email,Email address\r\na@example.test,b@example.test\r\n');
      await assert.rejects(importLegacySuppressions(db,workspace,file),/exactly one/);
      t.diagnostic(`31,001 CSV rows across quoted multiline fields, 31,000 durable opt-outs, zero opt-ins. Preview, changed file, invalid final row, import and replay: ${Math.round(performance.now()-begin)} ms locally.`);
    }finally{
      await rm(folder,{recursive:true,force:true});await client?.end({timeout:3});
      try{if(created)await admin.unsafe('DROP DATABASE '+name);}finally{await admin.end({timeout:3});}
    }
  });
