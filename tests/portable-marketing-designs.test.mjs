import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {applyPortableMigrations,readPortableMigrations} from '../runtime/portable-migrations.mjs';

async function bundle(path,plugins=[]){
  const compiled=await build({entryPoints:[fileURLToPath(new URL(path,import.meta.url))],bundle:true,
    platform:'node',format:'esm',write:false,plugins});
  return import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
}
const {createBeefreeSession}=await bundle('../runtime/portable-marketing-design-auth.ts');
const {openBeefreeEditor}=await bundle('../runtime/portable-marketing-design-editor.ts');
const {marketingDesignAction}=await bundle('../lib/marketing-design.ts');
const workspace=randomUUID(),owner='beefree-design-owner',other='beefree-other-owner';
const credentials={HARBOR_BEEFREE_CLIENT_ID:'fake-client-id',HARBOR_BEEFREE_CLIENT_SECRET:'fake-secret'};
const session={uid:'harbor-'+workspace,token:{access_token:'fixture-temporary-token',v2:true}};

test('only server credentials and a workspace UID reach the fixed Beefree authorization endpoint',async()=>{
  const result=await createBeefreeSession(workspace,credentials,async(url,options)=>{
    assert.equal(url,'https://auth.getbee.io/loginV2');
    assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body),{client_id:'fake-client-id',client_secret:'fake-secret',uid:session.uid});
    return Response.json({...session.token,unexpected:'keep provider fields private'});
  });
  assert.deepEqual(result,session);
  let outgoing=0;
  await assert.rejects(createBeefreeSession(workspace,{},async()=>{outgoing++;}),{status:409});assert.equal(outgoing,0);
  for(const reply of [Response.json({detail:'sensitive provider diagnostics'},{status:401}),Response.json({access_token:'x',v2:false}),
    new Response('x'.repeat(32769))]){
    await assert.rejects(createBeefreeSession(workspace,credentials,async()=>reply),failure=>
      failure.status===502&&!failure.message.includes('sensitive provider diagnostics'));
  }
});

test('the official SDK create/start/save contract loads a new or saved design, renews the same workspace session and releases the editor',async()=>{
  const savedJson=JSON.stringify({page:{title:'Fictional renewal'}}),html='<h1>Fictional renewal</h1>';
  for(const project of [undefined,savedJson]){
    let authCalls=0,config,started,ready=0,saved,updated,closed=0;
    const builder={start(value){started=value;config.onLoad();},save(){config.onSave(savedJson,html);},
      updateToken(value){updated=value;},destroy(){closed++;}};
    const testPlugin={create(token,options,accept){
      config=options;assert.deepEqual(token,session.token);assert.equal(options.uid,session.uid);assert.equal(options.trackChanges,true);accept(builder);
    }};
    const editor=openBeefreeEditor('editor',project,async()=>{authCalls++;return session;},{
      ready(){ready++;},changed(){},saved(json,value){saved=[json,value];},error:assert.fail,
    },async()=>testPlugin);
    await tick();
    assert.deepEqual(started,project?JSON.parse(project):{comments:{},page:{}});assert.equal(ready,1);
    editor.save();assert.deepEqual(saved,[savedJson,html]);
    config.onError({code:5101});await tick();assert.equal(authCalls,2);assert.deepEqual(updated,session.token);
    editor.close();assert.equal(closed,1);config.onSave(savedJson,'late callback');assert.deepEqual(saved,[savedJson,html]);
  }
  let vendorLoad=0,error;
  openBeefreeEditor('editor',undefined,async()=>{throw Error('forbidden');},{
    ready:assert.fail,changed:assert.fail,saved:assert.fail,error:value=>{error=value;},
  },async()=>{vendorLoad++;});
  await tick();assert.equal(error,'forbidden');assert.equal(vendorLoad,0);
});

const original={action:'save',id:randomUUID(),name:'Expiry reminder',subject:'Your upcoming renewal',plainText:'Your renewal',
  project:JSON.stringify({page:{rows:[{}]}}),html:'<p>Your renewal</p>'};
test('editable project, rendered output, subject and size are checked independently',()=>{
  assert.deepEqual(marketingDesignAction.parse(original),original);
  for(const fields of [{project:'{}'},{project:'[]'},{project:'not JSON'},{project:'{"page":[]}'},
    {project:'{"kind":"harbor-email","page":{}}'},{html:' '},
    {subject:'two\nlines'},{name:'\0name'},{html:'a'.repeat(1024*1024+1)},{expectedRevision:0}]){
    assert.equal(marketingDesignAction.safeParse({...original,...fields}).success,false);
  }
});

const database=process.env.HARBOR_TEST_POSTGRES_URL;
test('design HTTP handlers isolate owners, return bounded lists, preserve the edit document, and reject stale saves on PostgreSQL 18',
  {skip:!database,timeout:60_000},async t=>{
    const base=new URL(database);
    assert.equal(base.hostname,'127.0.0.1');
    assert.match(base.pathname,/^\/harbor_identity_test(?:_[a-z0-9]+)?$/);
    const admin=postgres(base.href,{max:1,onnotice:()=>{}}),name='harbor_design_'+randomUUID().replaceAll('-','');
    let sql;
    try{
      await admin`CREATE DATABASE ${admin(name)}`;
      base.pathname='/'+name;sql=postgres(base.href,{max:3,onnotice:()=>{}});
      assert.equal(await applyPortableMigrations(sql,readPortableMigrations(resolve('db/postgres/migrations'))),'ok');
      for(const id of [owner,other])await sql`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
        VALUES(${id},${id},${id+'@example.test'},1,1)`;
      await sql`INSERT INTO private_workspaces(id,owner_id) VALUES(${workspace},${owner}),(${randomUUID()},${other})`;
      Object.assign(process.env,{...credentials,HARBOR_MARKETING_WORKSPACE_ID:workspace});
      // Session parsing and the DB connection are supplied by the fixture. Route, workspace ownership, schema and store are real.
      const route=await bundle('../runtime/portable-marketing-design-routes.ts',[{
        name:'marketing-test-session',setup(build){
          build.onResolve({filter:/^\.\/portable-(api-identity|db)$/},({path})=>({path,namespace:'local-fixture'}));
          build.onLoad({filter:/.*/,namespace:'local-fixture'},({path})=>({contents:path.endsWith('db')?
            'export const portableDb=()=>globalThis.harborDesignTestDb':
            'export const portableApiIdentity=r=>r.headers.has("actor")?{userId:r.headers.get("actor"),guest:false}:new Response(null,{status:401})'}));
        },
      }]);
      globalThis.harborDesignTestDb=drizzle(sql);
      const call=(actor,body,search='')=>{
        const headers=actor?{actor}:{};
        const req=new Request('http://127.0.0.1/api/marketing/designs'+search,body?
          {method:'POST',headers,body:JSON.stringify(body)}:{headers});
        return (body?route.POST:route.GET)(req);
      };
      let tokens=0;
      t.mock.method(globalThis,'fetch',async()=>{tokens++;return Response.json(session.token);});
      assert.equal((await call(null,{action:'session'})).status,401);
      assert.equal((await call(other,{action:'session'})).status,403);
      assert.equal(tokens,0);assert.deepEqual(await (await call(owner,{action:'session'})).json(),session);
      assert.equal(tokens,1);
      assert.equal((await call(other,original)).status,403);
      const create=await call(owner,original);assert.equal(create.status,200);
      assert.match(create.headers.get('cache-control'),/no-store/);
      assert.equal((await create.json()).design.revision,1);
      assert.equal((await (await call(owner,original)).json()).design.revision,1);
      const load=()=>call(owner,null,'?id='+original.id).then(r=>r.json()).then(r=>r.design);
      assert.deepEqual(await load(),{id:original.id,name:original.name,subject:original.subject,plainText:original.plainText,
        project:original.project,html:original.html,revision:1});
      const updates=['New subject','Changed by another editor'].map(subject=>({...original,expectedRevision:1,subject}));
      const writes=await Promise.all(updates.map(value=>call(owner,value)));assert.deepEqual(writes.map(r=>r.status).sort(),[200,409]);
      const winner=updates[writes.findIndex(r=>r.status===200)];
      assert.equal((await (await call(owner,winner)).json()).design.revision,2);assert.equal((await load()).subject,winner.subject);
      assert.equal((await call(other,null,'?id='+original.id)).status,403);
      for(let i=0;i<25;i++)assert.equal((await call(owner,{...original,id:randomUUID(),name:'Design '+i})).status,200);
      const first=await (await call(owner)).json();assert.equal(first.items.length,25);
      assert.equal(first.configured,true);assert.ok(first.items.every(item=>!('project' in item)&&!('html' in item)));
      const second=await (await call(owner,null,'?after='+first.next)).json();assert.equal(second.items.length,1);assert.equal(second.next,null);
      assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,26);
    }finally{
      delete globalThis.harborDesignTestDb;
      await sql?.end();await admin`DROP DATABASE IF EXISTS ${admin(name)}`;await admin.end();
    }
  });
