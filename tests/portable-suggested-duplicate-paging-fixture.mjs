import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {tsImport} from 'tsx/esm/api';
import {drizzle} from 'drizzle-orm/postgres-js';
import {sql as query} from 'drizzle-orm';
import {findDuplicates} from '../lib/duplicates.ts';

export async function verifySuggestedDuplicatePaging({get,ok,sql,workspaceId}){
  const marker='Cobalt';
  const company=(name,domain,city)=>({kind:'companies',id:randomUUID(),data:{name,domain,city}});
  const companies=[
    company('Cobalt Café, Inc.','WWW.cobalt.example.test','Bogotá'),company('Cobalt Cafe LLC','https://cobalt.example.test/a','Bogota'),
    company('Cobalt River','other.example.test','東京'),company('Cobalt Rivre','fable.example.test','東京'),
    company('Cobalt 秋','', ''),company('Cobalt 秋, Inc','', ''),company('Cobalt Station','cobalt-station.example.test',''),
    company('Cobalt Harbor','https://www.cobalt-station.example.test:443/path',''),
    company('San Francisco LLC','','Crowded city'),company('San Francisko Co.','','Crowded city'),
    company('Cobalt Madrico LLC','','Crowded city'),company('Cobalt Madriko Co.','','Crowded city'),
    company('Cobalt A東京b','','Crowded city'),company('Cobalt A東京c Inc.','','Crowded city'),
    company('Cobalt Harbor West','bücher.test',''),company('Cobalt Other','xn--bcher-kva.test','')
  ];
  const contact=(name,email,companyId)=>({kind:'contacts',id:randomUUID(),data:{name,email,companyId}});
  const contacts=[
    contact('Cobalt Adèle','ada@example.test'),contact('Cobalt Adele','other@example.test'),
    contact('Cobalt Jones','third@example.test',companies[0].id),contact('Cobalt Jnoes','fourth@example.test',companies[1].id),
    contact('Cobalt Åsa','SHARED@Example.test'),contact('Different Name','shared@example.test'),
    contact('Cobalt Ambre','aa@example.test',companies[1].id),contact('Cobalt Amber','ab@example.test',companies[0].id),
    contact('Cobalt Firstlight','original@example.test',companies[0].id),contact('Cobalt Firtslight','typo@example.test',companies[0].id),
    contact('Cobalt 金','left@example.test'),contact('Cobalt 金','right@example.test'),
    contact('Cobalt Kestrel 5%_','punctuation@example.test'),contact('Different Spelling','punctuation@example.test'),
  ];
  for(const {id,data} of companies)await sql`INSERT INTO companies(id,workspace_id,data,revision,created_at,updated_at)
    VALUES(${id},${workspaceId},${sql.json(data)},1,now(),now())`;
  for(const {id,data:{companyId,...data}} of contacts)await sql`INSERT INTO contacts(id,workspace_id,data,primary_company_id,revision,created_at,updated_at)
    VALUES(${id},${workspaceId},${sql.json(data)},${companyId??null},1,now(),now())`;
  await sql`INSERT INTO companies(id,workspace_id,data,revision,created_at,updated_at)
    SELECT gen_random_uuid(),${workspaceId},jsonb_build_object('name','Larch Supplier '||n,
      'domain','larch-'||n||'.example.test'),1,now(),now() FROM generate_series(1,30000) n`;
  // Distinct alphabetic names exercise a common city/employer without a numeric ID
  // in the name providing an easy shortcut. Include real matches in those groups.
  const crowd=5000;
  const letters=query`translate(left(md5(n::text),24),'0123456789','ghijklmnop')`;
  const name=query`CASE WHEN n%2=0 THEN 'Coastal studio '||${letters} ELSE ${letters}||' manufacturing' END`;
  const db=drizzle(sql);
  await db.execute(query`INSERT INTO companies(id,workspace_id,data,revision,created_at,updated_at)
    SELECT gen_random_uuid(),${workspaceId},jsonb_build_object('name',${name},'city','Crowded city'),1,now(),now()
    FROM generate_series(1,${crowd}::integer) n`);
  await db.execute(query`INSERT INTO contacts(id,workspace_id,data,primary_company_id,revision,created_at,updated_at)
    SELECT gen_random_uuid(),${workspaceId},jsonb_build_object('name',${name}),${companies[0].id},1,now(),now()
    FROM generate_series(1,${crowd}::integer) n`);
  await sql`ANALYZE companies`;
  const {suggestedCandidateIds}=await tsImport('../db/postgres/duplicate-candidates.ts',import.meta.url);
  for(const kind of ['contacts','companies']){
    const candidates=await suggestedCandidateIds(db,workspaceId,kind);
    const rows=await db.execute(query`SELECT id FROM ${candidates} AS candidates`);
    console.log(kind+' admitted for scoring including '+crowd+' common-location records:',rows.length);
    assert.ok(rows.length<150,'Unrelated names in a common city or employer should stay in SQL: '+kind+' '+rows.length);
  }
  const key=pair=>[pair.left.id,pair.right.id,pair.score,pair.reasons];
  for(const kind of ['contacts','companies']){
    const times=[];
    for(const strength of ['all','strong','possible','all','all']){
      const expected=findDuplicates([...contacts,...companies],kind,10000,{query:marker,strength});
      assert.ok(expected.pairs.length);
      const start=performance.now();
      const result=await(await ok(get('/api/duplicates?'+new URLSearchParams({kind,query:marker,strength})))).json();
      times.push(Math.round(performance.now()-start));
      assert.deepEqual(result.pairs.map(key),expected.pairs.map(key));
      assert.equal(result.total,expected.pairs.length);
      assert.equal(result.limited,false);
      if(kind==='contacts')assert.ok(result.recordsChecked>=70_000);
    }
    const ordinary=[],ordinaryTimes=[];
    let cursor;
    const relevant=new Set((kind==='contacts'?contacts:companies).map(row=>row.id));
    do{
      const start=performance.now();
      const result=await(await ok(get('/api/duplicates?'+new URLSearchParams({kind,...(cursor?{cursor}:{})})))).json();
      assert.equal(result.limited,false);
      ordinary.push(...result.pairs.filter(pair=>relevant.has(pair.left.id)||relevant.has(pair.right.id)).map(key));
      cursor=result.nextCursor;
      ordinaryTimes.push(Math.round(performance.now()-start));
    }while(cursor);
    console.log('Ordinary duplicate pages ('+kind+', ms):',ordinaryTimes.join(', '));
    assert.deepEqual(ordinary,findDuplicates([...contacts,...companies],kind).pairs.map(key));
    if(kind==='contacts')console.log('Suggested contact pairs, 70,000 fictional contacts, first-page requests (ms):',times.join(', '));
  }
  for(const needle of ['kestrel 5%_','5%_','PUNCTUATION@','Firtslight','not-a-match_']){
    const page=await(await ok(get('/api/duplicates?'+new URLSearchParams({kind:'contacts',query:needle})))).json();
    assert.deepEqual(page.pairs.map(key),findDuplicates([...contacts,...companies],'contacts',10000,{query:needle}).pairs.map(key),needle);
  }
  // Broad fallback for many uncommon URL spellings must also retain their ordinary ASCII partners.
  await sql`INSERT INTO companies(id,workspace_id,data,revision,created_at,updated_at)
    SELECT gen_random_uuid(),${workspaceId},jsonb_build_object('name','Fictional URL fixture '||n,
      'domain','https://%65xample'||n||'.test'),1,now(),now() FROM generate_series(1,257) n`;
  const fallback=await(await ok(get('/api/duplicates?kind=companies&query=Cobalt'))).json();
  assert.deepEqual(fallback.pairs.map(key),findDuplicates(companies,'companies',10000,{query:marker}).pairs.map(key));
  // An exceptional URL still pairs with its ASCII spelling when only one side matches,
  // even with enough unrelated exceptional domains to trigger the full-list fallback.
  for(const needle of ['xn--bcher-kva','bücher.test','cobalt-station.example.test','Rivre','金']){
    const page=await(await ok(get('/api/duplicates?'+new URLSearchParams({kind:'companies',query:needle})))).json();
    assert.deepEqual(page.pairs.map(key),findDuplicates(companies,'companies',10000,{query:needle}).pairs.map(key),needle);
  }
  const canonical=randomUUID(),escaped='https://%65xample42.test';
  await sql`INSERT INTO companies(id,workspace_id,data,revision,created_at,updated_at) VALUES
    (${canonical},${workspaceId},'{"name":"Canonical example","domain":"example42.test"}',1,now(),now())`;
  const [partner]=await sql`SELECT id FROM companies WHERE workspace_id=${workspaceId} AND data->>'domain'=${escaped}`;
  for(const needle of ['%65xample','example42.test']){
    const page=await(await ok(get('/api/duplicates?'+new URLSearchParams({kind:'companies',query:needle})))).json();
    assert.deepEqual(page.pairs.map(p=>[p.left.id,p.right.id]),[[canonical,partner.id].sort()],needle);
  }
  await verifyLargeNameGroup({get,ok,sql,workspaceId});
  for(const [kind,needle] of [['contacts','original@example.test'],['companies','xn--bcher-kva']]){
    const countCandidates=async search=>{
      const candidates=await suggestedCandidateIds(db,workspaceId,kind,undefined,search);
      const [row]=await db.execute(query`SELECT count(*)::int AS count FROM ${candidates} AS candidates`);
      return row.count;
    };
    const all=await countCandidates(''),searched=await countCandidates(needle);
    console.log(kind+' candidate records for all suggestions / targeted search:',all,searched);
    assert.ok(all>=2000&&searched<400,kind+' search must drop unrelated duplicate groups before application scoring');
  }
}

async function verifyLargeNameGroup({get,ok,sql,workspaceId}){
  const prefix='ac000000-0000-4000-8000-';
  const id=n=>prefix+String(n).padStart(12,'0');
  const size=2000,needle=1000;
  await sql`INSERT INTO contacts(id,workspace_id,data,revision,created_at,updated_at)
    SELECT (${prefix}||lpad(n::text,12,'0'))::uuid,${workspaceId},
      jsonb_build_object('name','Fictional Cedar Buyer','email','cedar+'||n||'@example.test'),1,now(),now()
    FROM generate_series(1,${size}::int) n`;
  const expected=Array.from({length:size},(_,i)=>i+1).filter(n=>n!==needle)
    .map(n=>[70,id(Math.min(n,needle)),id(Math.max(n,needle))]);
  const route='/api/duplicates?kind=contacts&query='+encodeURIComponent('cedar+'+needle+'@example.test');
  const times=[];
  for(const startAt of [0,needle-25,size-26]){
    const start=performance.now();
    const page=await(await ok(get(route+(startAt?'&cursor='+encodeURIComponent(JSON.stringify(expected[startAt-1])):'')))).json();
    times.push(Math.round(performance.now()-start));
    assert.equal(page.total,size-1);
    assert.deepEqual(page.pairs.map(p=>[p.score,p.left.id,p.right.id]),expected.slice(startAt,startAt+50));
  }
  console.log('Email search in a 2,000-contact name group, first/middle/last pages (ms):',times.join(', '));
}
