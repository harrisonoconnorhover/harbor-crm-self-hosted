import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import {applyPortableMigrations,readPortableMigrations} from '../runtime/portable-migrations.mjs';

test('An ordinary database owner can index records already present before migration 0129',{
  skip:process.env.HARBOR_TEST_SEARCH_ONLY!=='true',
},async()=>{
  const address=new URL(process.env.HARBOR_TEST_POSTGRES_URL);
  assert.equal(address.hostname,'127.0.0.1');
  assert.equal(address.pathname,'/harbor_identity_test');
  const admin=postgres(address.href,{max:1,onnotice:()=>{}});
  let db;
  try{
    // This cluster belongs exclusively to this local run and is removed by its fixture runner.
    await admin`CREATE ROLE harbor_search_owner NOSUPERUSER`;
    await admin`CREATE DATABASE harbor_search_upgrade OWNER harbor_search_owner`;
    address.pathname='/harbor_search_upgrade';
    db=postgres(address.href,{max:1,connection:{role:'harbor_search_owner'},onnotice:()=>{}});
    const [role]=await db`SELECT current_user AS name,rolsuper FROM pg_roles WHERE rolname=current_user`;
    assert.deepEqual({...role},{name:'harbor_search_owner',rolsuper:false});
    const migrations=readPortableMigrations('db/postgres/migrations');
    const boundary=migrations.findIndex(entry=>entry.sql.some(statement=>statement.includes('CREATE FUNCTION public.harbor_search_values')));
    assert.ok(boundary>0);
    assert.equal(await applyPortableMigrations(db,migrations.slice(0,boundary)),'ok');
    const workspace=randomUUID();
    await db`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
      VALUES ('sales-owner','fixture-owner','fictional@example.test',0,0)`;
    await db`INSERT INTO private_workspaces(id,owner_id) VALUES (${workspace},'sales-owner')`;
    await db`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      SELECT ${workspace},gen_random_uuid(),1,jsonb_build_object('email','person'||i||'@example.test','city','Fictional city'),now(),now()
      FROM generate_series(1,70000) i`;
    const start=performance.now();
    assert.equal(await applyPortableMigrations(db,migrations),'ok');
    console.log('Index upgrade on 70,000 existing contacts:',Math.round(performance.now()-start),'ms');
    const [check]=await db`SELECT count(*)::int AS total,count(*) FILTER(WHERE (public.harbor_search_values(data) COLLATE "C")
      LIKE '%person70000@example.test%')::int AS matched FROM contacts WHERE workspace_id=${workspace}`;
    assert.deepEqual({...check},{total:70000,matched:1});
    assert.equal(await applyPortableMigrations(db,migrations),'ok');
  }finally{
    if(db)await db.end();
    await admin.end();
  }
});
