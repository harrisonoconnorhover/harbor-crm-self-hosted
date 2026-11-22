import assert from 'node:assert/strict';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {tsImport} from 'tsx/esm/api';

export async function verifyDismissedDuplicatePaging({get,send,ok,sql,other,workspaceId}){
  const size=70_000;
  const label='Fictional Marlin %_';
  const prefix='ab000000-0000-4000-8000-';
  const id=n=>prefix+String(n).padStart(12,'0');
  await sql`INSERT INTO contacts (id,workspace_id,revision,data,created_at,updated_at)
    SELECT (${prefix}||lpad(n::text,12,'0'))::uuid,${workspaceId},1,
      jsonb_build_object('name',CASE WHEN n<=35 THEN ${label} ELSE 'Fictional filler '||n END,
        'email',CASE WHEN n BETWEEN 23 AND 36 THEN 'marlin@example.test' ELSE n||'@example.test' END),
      now(),now() FROM generate_series(1,${size}::int) n`;
  await sql`INSERT INTO portable_duplicate_dismissals(workspace_id,kind,record_a,record_b,actor_id,created_at)
    SELECT ${workspaceId},'contacts',(${prefix}||lpad(a::text,12,'0'))::uuid,(${prefix}||lpad(b::text,12,'0'))::uuid,i.id,now()
      FROM generate_series(1,36) a CROSS JOIN generate_series(1,36) b CROSS JOIN login_identities i
      WHERE a<b AND i.email='owner@example.test'`;
  await sql`ANALYZE contacts`;
  const [active]=await sql`SELECT count(*)::int AS n FROM contacts WHERE workspace_id=${workspaceId} AND archived_at IS NULL`;
  const expected=[];
  for(let a=1;a<=36;a++)for(let b=a+1;b<=36;b++){
    expected.push([a>=23?100:b<=35?70:0,id(a),id(b)]);
  }
  expected.sort((a,b)=>b[0]-a[0]||a[1].localeCompare(b[1])||a[2].localeCompare(b[2]));
  const page=async params=>(await ok(get('/api/duplicates?'+new URLSearchParams({kind:'contacts',query:label,status:'dismissed',...params})))).json();
  const keys=result=>result.pairs.map(pair=>[pair.score,pair.left.id,pair.right.id]);
  const times=[];
  for(let i=0;i<5;i++){
    const start=performance.now(),first=await page({});
    times.push(Math.round(performance.now()-start));
    assert.equal(first.total,630);
    assert.equal(first.recordsChecked,active.n);
    assert.deepEqual(keys(first),expected.slice(0,50));
  }
  const seen=[];
  let cursor;
  do{
    const current=await page(cursor?{cursor}:{});
    assert.equal(current.total,630);
    seen.push(...keys(current));
    cursor=current.nextCursor;
  }while(cursor&&seen.length<=expected.length);
  assert.deepEqual(seen,expected);
  const possible=await page({strength:'possible'});
  assert.equal(possible.total,expected.filter(row=>row[0]<90).length);
  const strong=await page({strength:'strong'});
  assert.equal(strong.total,expected.filter(row=>row[0]>=90).length);
  await sql`INSERT INTO portable_duplicate_dismissals(workspace_id,kind,record_a,record_b,actor_id,created_at)
    SELECT ${workspaceId},'contacts',(${prefix}||lpad(a::text,12,'0'))::uuid,(${prefix}||lpad((a+1)::text,12,'0'))::uuid,i.id,now()
      FROM generate_series(100,40098,2) a CROSS JOIN login_identities i WHERE i.email='owner@example.test'`;
  const marker='Café 30%_A';
  await sql`UPDATE contacts SET data=data||jsonb_build_object('name',${marker}::text)
    WHERE workspace_id=${workspaceId} AND id IN ${sql([500,501,503,40000].map(id))}`;
  await sql`UPDATE contacts SET data=data||jsonb_build_object('phone',${marker}::text)
    WHERE workspace_id=${workspaceId} AND id=${id(504)}`;
  await sql`VACUUM (ANALYZE) contacts`;
  await sql`ANALYZE portable_duplicate_dismissals`;
  const selective=[];
  for(let i=0;i<5;i++){
    const start=performance.now(),result=await page({query:'CAFÉ 30%_a'});
    selective.push(Math.round(performance.now()-start));
    assert.equal(result.total,3);
    assert.deepEqual(result.pairs.map(pair=>pair.left.id).sort(),[500,502,40000].map(id));
  }
  assert.equal((await page({query:'Café 30XXA'})).total,0);
  assert.equal((await page({query:'MARLIN@EXAMPLE.TEST'})).total,630-22*21/2);
  assert.equal((await page({query:'%_'})).total,633);
  const broad=await page({query:'fictional filler'});
  assert.equal(broad.total,20_000-1+35); // One pair lost both filler names. Record 36 appears in 35 earlier pairs.
  assert.equal(broad.pairs.length,50);
  assert.ok(broad.nextCursor);
  console.log('Dismissed pair search across 20,630 fictional decisions, median ms:',selective.sort((a,b)=>a-b)[2]);
  console.log('Dismissed pairs, 70,000 fictional contacts, five first-page requests (ms):',times.join(', '));
  await verifyLimitedReview({get,send,ok,sql,other,workspaceId,ids:[id(1),id(2),id(3)],hidden:id(4),label});
}

async function verifyLimitedReview({get,send,ok,sql,other,workspaceId,ids,hidden,label}){
  const email='other@example.test';
  const [rep]=await sql`SELECT id FROM login_identities WHERE email=${email}`;
  const manage=async input=>(await (await ok(send('/api/workspaces',input))).json()).viewers.find(v=>v.email===email);
  let grant=await manage({action:'grant',email});
  grant=await manage({action:'role',id:grant.id,role:'editor'});
  grant=await manage({action:'record_scope',id:grant.id,viewScope:'all',editScope:'owned'});
  const scope=new URLSearchParams({workspaceId,grantId:grant.id});
  const page=async(status,query='')=>(await (await ok(get('/api/duplicates?'+scope+'&'+new URLSearchParams({kind:'contacts',status,query}),other))).json());
  await sql`UPDATE contacts SET data=data||jsonb_build_object('recordOwner',
    jsonb_build_object('workspaceId',workspace_id,'userId',${rep.id}::text)) WHERE workspace_id=${workspaceId} AND id IN ${sql(ids)}`;
  const idsInPage=result=>result.pairs.filter(pair=>ids.includes(pair.left.id)||ids.includes(pair.right.id))
    .map(pair=>[pair.left.id,pair.right.id]);
  try{
    // Observe rows returned by Postgres itself. Checking the final page alone would also
    // pass if Harbor loaded every other team's decision and stripped them in JavaScript.
    const {readPortableDuplicates}=await tsImport('../db/postgres/portable-duplicate-store.ts',import.meta.url);
    let hiddenValues=0,visibleValues=0;
    const probe=postgres(process.env.HARBOR_TEST_POSTGRES_URL,{max:1,transform:{value:{from(value){
      if(value===hidden)hiddenValues++;
      if(value===ids[0])visibleValues++;
      return value;
    }}}});
    try{
      for(const status of ['suggested','dismissed']){
        visibleValues=0;
        await drizzle(probe).transaction(tx=>readPortableDuplicates(tx,workspaceId,{kind:'contacts',status,query:'',strength:'all'},rep.id));
        assert.ok(visibleValues>0,status+' must exercise the database read');
        assert.equal(hiddenValues,0,status+' loaded an out-of-scope pair from Postgres');
      }
    }finally{await probe.end();}
    const elapsed={suggested:[],dismissed:[]};
    for(const status of ['dismissed','suggested']){
      for(let i=0;i<3;i++){
        const start=performance.now(),result=await page(status);
        elapsed[status].push(Math.round(performance.now()-start));
        assert.deepEqual(idsInPage(result),status==='dismissed'?[[ids[0],ids[1]],[ids[0],ids[2]],[ids[1],ids[2]]]:[]);
      }
    }
    const action=(name)=>send('/api/duplicates?'+scope,{action:name,kind:'contacts',recordA:ids[0],recordB:ids[2]},other);
    await ok(action('restore'));
    assert.deepEqual(idsInPage(await page('suggested',label)),[[ids[0],ids[2]]]);
    await ok(action('dismiss'));
    await sql`UPDATE contacts SET data=data-'recordOwner' WHERE workspace_id=${workspaceId} AND id=${ids[2]}`;
    assert.deepEqual(idsInPage(await page('dismissed',label)),[[ids[0],ids[1]]]);
    assert.equal((await action('restore')).status,404);
    console.log('Scoped duplicate review, 20,630 dismissals, median ms:',Object.fromEntries(
      Object.entries(elapsed).map(([status,times])=>[status,times.sort((a,b)=>a-b)[1]])));
  }finally{
    await manage({action:'revoke',id:grant.id});
    await sql`UPDATE contacts SET data=data-'recordOwner' WHERE workspace_id=${workspaceId} AND id IN ${sql(ids)}`;
  }
}
