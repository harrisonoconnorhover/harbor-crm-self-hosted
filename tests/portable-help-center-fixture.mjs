import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifyCategoryPages} from './portable-knowledge-category-pages.mjs';
import {verifyCustomerCasePortal} from './portable-case-portal-fixture.mjs';

export async function verifyHelpCenter({request,origin,headers,other,sql}){
  const api='/api/knowledge-base',settings=api+'?publication=1',id=randomUUID();
  const post=(url,data,actor=headers)=>request(url,{method:'POST',headers:{...actor,origin,'content-type':'application/json'},body:JSON.stringify(data)});
  const ok=async pending=>{const r=await pending;assert.ok(r.ok,await r.clone().text());return r.json();};
  const read=async(url,status=200)=>{const r=await request(url);assert.equal(r.status,status,url);assert.match(r.headers.get('cache-control')??'',/no-store/);return r.text();};
  const config={action:'settings',name:'Juniper Help',accent:'#513281',enabled:true,revision:0};
  const content={title:'Battery replacement',subtitle:'Instructions for field technicians',tags:['Internal-tag'],category:'Internal label',
    bodyHtml:'<p>Inspect the <strong>connector</strong>.</p><script>secretScript()</script>'};
  const draft=await ok(post(api,{action:'save',id,revision:0,content}));
  const {center}=await ok(post(settings,config));
  const path='/help/'+center.id,article=path+'/'+id;
  assert.match(await read(path),/Juniper Help/);
  await read(article,404);
  assert.equal((await post(settings,config)).status,409);
  const publish={action:'publish',id,articleRevision:draft.item.revision,revision:0};
  assert.equal((await post(settings,publish,{})).status,401);
  const unrelated=await ok(post(settings,{...config,name:'Unrelated Help'},other));
  assert.equal((await post(settings,publish,other)).status,404);
  await publishAndBrowseTopics({origin,headers,path,id});
  const topics=path+'?browse=topics';
  assert.doesNotMatch(await read(topics),/Internal label|Internal-tag|Retired topic/);
  assert.doesNotMatch(await read('/help/'+unrelated.center.id+'?browse=topics'),/Field repairs/);
  await read(path+'?topic=Other&q=battery+conector',404);
  await read('/help/'+unrelated.center.id+'?topic=Field+repairs',404);
  await read('/help/'+unrelated.center.id+'/'+id,404);
  assert.doesNotMatch(await read('/help/'+unrelated.center.id+'?q=connector'),/Battery replacement/);
  assert.match(await read(path+'?q=connector'),/Battery replacement/);
  const literal=await read(path+'?q=CONNECTOR+battery');
  assert.match(literal,/Battery replacement/);
  assert.doesNotMatch(literal,/Similar articles/);
  const suggested=await read(path+'?q=battery+conector');
  assert.match(suggested,/<h2>Similar articles<\/h2>/);
  assert.ok(suggested.includes('href="'+article+'">Battery replacement</a>'));
  for(const query of ['conector+unknown','conector%25','conector7','intternal']){
    assert.doesNotMatch(await read(path+'?q='+query),/Battery replacement/);
  }
  assert.doesNotMatch(await read('/help/'+unrelated.center.id+'?q=conector'),/Battery replacement/);
  assert.doesNotMatch(await read(path+'?q=conector&after='+id),/Similar articles|Battery replacement/);
  assert.doesNotMatch(await read(path+'?q=battery+unknown'),/Battery replacement/);
  for(const query of ['internal-tag','battery+Internal-tag','%25','_']){
    assert.doesNotMatch(await read(path+'?q='+query),/Battery replacement/);
  }
  assert.doesNotMatch(await read(article),/Internal label|Internal-tag|secretScript/);
  assert.match(await read(article),/<strong>connector<\/strong>/);
  const edit=await ok(post(api,{action:'save',id,revision:1,content:{...content,title:'Battery inspection',bodyHtml:'<p>New gasket</p>'}}));
  assert.doesNotMatch(await read(article),/New gasket/);
  for(const query of ['gasket','gaskett'])assert.doesNotMatch(await read(path+'?q='+query),/Battery/);
  assert.equal((await post(settings,{...publish,revision:1})).status,409);
  assert.equal((await post(settings,{...publish,revision:1,articleRevision:edit.item.revision,topic:'Stale topic'})).status,409);
  const updated=await ok(post(settings,{...publish,revision:2,articleRevision:edit.item.revision}));
  assert.equal(updated.publication.topic,'Field repairs','Older publish clients preserve the public topic.');
  assert.match(await read(path+'?q=gasket'),/Battery inspection/);
  assert.match(await read(article),/New gasket/);
  await ok(post(settings,{...config,revision:1,enabled:false}));await read(path,404);await read(article,404);await read(topics,404);
  await ok(post(settings,{...config,revision:2}));assert.match(await read(article),/New gasket/);
  await ok(post(settings,{...publish,action:'withdraw',revision:3,articleRevision:2}));await read(article,404);
  assert.doesNotMatch(await read(topics),/Field repairs/);
  await read(path+'?topic=Field+repairs',404);
  await ok(post(settings,{...publish,revision:4,articleRevision:2,topic:'Field repairs'}));
  await ok(post(api,{action:'archive',archived:true,id,revision:2}));await read(article,404);
  await ok(post(api,{action:'archive',archived:false,id,revision:3}));await read(article,404);
  assert.doesNotMatch(await read(path),/Battery inspection/);
  assert.doesNotMatch(await read(topics),/Field repairs/);
  // Publish enough fictional editions to exercise the public, filtered pagination boundary.
  const [{workspace_id:w}]=await sql`SELECT workspace_id FROM portable_help_centers WHERE id=${center.id}`;
  await sql.begin(async tx=>{
    const drafts=await tx`INSERT INTO portable_knowledge_articles(workspace_id,id,content,excerpt,search_text,revision,created_at,updated_at)
      SELECT ${w},gen_random_uuid(),jsonb_build_object('title',title,'subtitle','','bodyHtml',CASE WHEN n<=4 THEN '<p>Field kit instructions</p>' ELSE '<p>Kit instructions</p>' END,
        'tags',jsonb_build_array(),'category','','categoryId',NULL),'Field kit instructions',
        lower(title)||' '||CASE WHEN n<=4 THEN 'field kit instructions' ELSE 'kit instructions' END,1,0,0
      FROM generate_series(1,29) n CROSS JOIN LATERAL (SELECT (CASE WHEN n<=2 THEN 'Field kit guide ' ELSE 'Field guide ' END)||n AS title) edition RETURNING id`;
    const ids=drafts.map(row=>row.id);
    await tx`INSERT INTO portable_knowledge_versions(workspace_id,article_id,revision,content,action,saved_at,changed_by_id)
      SELECT a.workspace_id,a.id,1,a.content,'created',0,w.owner_id FROM portable_knowledge_articles a
      JOIN private_workspaces w ON w.id=a.workspace_id WHERE a.workspace_id=${w} AND a.id IN ${tx(ids)}`;
    await tx`INSERT INTO portable_article_publications(workspace_id,article_id,published_revision,revision,search_text)
      SELECT workspace_id,id,1,1,search_text FROM portable_knowledge_articles WHERE workspace_id=${w} AND id IN ${tx(ids)}`;
  });
  const firstPage=await read(path+'?q=field');
  const next=/href="([^"]+)">More articles/.exec(firstPage)?.[1];
  assert.ok(next);const secondPage=await read(next.replaceAll('&amp;','&'));
  const titles=html=>[...html.matchAll(/>Field (?:kit )?guide (\d+)<\/a>/g)].map(m=>m[1]);
  assert.equal(titles(firstPage).length,25);assert.equal(titles(secondPage).length,4);
  assert.equal(new Set([...titles(firstPage),...titles(secondPage)]).size,29);
  const search=await read(path+'?q=field+kit');
  const staffSearch='/api/knowledge-base?q=instructions+field+guide&match=words';
  const searchPage=await ok(request(staffSearch,{headers}));
  assert.equal(searchPage.items.length,25);
  const nextStaffPage=await ok(request(staffSearch+'&'+new URLSearchParams(searchPage.next),{headers}));
  assert.equal(new Set([...searchPage.items,...nextStaffPage.items].map(item=>item.id)).size,29);
  assert.deepEqual((await ok(request('/api/knowledge-base?q=instructions+field+guide',{headers}))).items,[]);
  const pageOne=titles(search);
  assert.deepEqual(pageOne.slice(0,2).sort(),['1','2'],'Title-prefix matches come first.');
  assert.deepEqual(pageOne.slice(2,4).sort(),['3','4'],'Other phrase matches precede separated terms.');
  const continueSearch=/href="([^"]+)">More articles/.exec(search)?.[1].replaceAll('&amp;','&');
  assert.ok(continueSearch);
  const anchor=new URL(continueSearch,origin).searchParams.get('after');
  assert.match(anchor,/^2:/);
  const pageTwo=titles(await read(continueSearch));
  assert.equal(new Set([...pageOne,...pageTwo]).size,29);
  assert.equal(pageTwo.length,4);
  const lastId=anchor.slice(2);
  await ok(post(settings,{action:'withdraw',id:lastId,articleRevision:1,revision:1}));
  assert.deepEqual(titles(await read(continueSearch)),pageTwo);
  const remaining=await sql`SELECT article_id FROM portable_article_publications
    WHERE workspace_id=${w} AND published_revision IS NOT NULL ORDER BY article_id`;
  const legacy=await read(path+'?q=field&after='+remaining[10].article_id);
  const links=[...legacy.matchAll(/<li><a href="[^"]+\/([0-9a-f-]{36})"/g)].map(m=>m[1]);
  assert.deepEqual(links,remaining.slice(11).map(row=>row.article_id));
  // Index pages exclude withdrawn articles and use a bounded cursor for both topics and articles.
  await sql`UPDATE portable_article_publications SET public_topic='Field guides'
    WHERE workspace_id=${w} AND published_revision IS NOT NULL`;
  // A neighboring edition can have a newer private draft. Visitors see the published title only.
  const [current,neighbor]=remaining.map(row=>row.article_id);
  const publicTitle=(await read(path+'/'+neighbor)).match(/<h1>([^<]+)<\/h1>/)[1];
  await ok(post(api,{action:'save',id:neighbor,revision:1,content:{...content,title:'Private manual replacement'}}));
  const foreign='00000000-0000-4000-8000-000000000001';
  await ok(post(api,{action:'save',id:foreign,revision:0,content:{...content,title:'Other center instructions'}},other));
  await ok(post(settings,{action:'publish',id:foreign,articleRevision:1,revision:0,topic:'Field guides'},other));
  const relatedPage=await read(path+'/'+current);
  const related=relatedPage.match(/<section><h2>More in Field guides<\/h2>(.*?)<\/section>/s)?.[1];
  assert.ok(related);
  assert.deepEqual([...related.matchAll(/href="[^"]+\/([0-9a-f-]{36})"/g)].map(m=>m[1]),remaining.slice(1,6).map(row=>row.article_id));
  assert.ok(related.includes('href="'+path+'/'+neighbor+'">'+publicTitle+'</a>'));
  assert.match(await read(path+'/'+neighbor),new RegExp('<h1>'+publicTitle+'</h1>'));
  assert.doesNotMatch(related,/Private manual replacement|Other center instructions/);
  assert.doesNotMatch(await read('/help/'+unrelated.center.id+'/'+foreign),/<h2>More in/);
  const topicResults=await read(path+'?topic=Field+guides&q=field');
  const nextTopicPage=/href="([^"]+)">More articles/.exec(topicResults)[1].replaceAll('&amp;','&');
  assert.equal(new URL(nextTopicPage,origin).searchParams.get('topic'),'Field guides');
  assert.equal(new Set([...titles(topicResults),...titles(await read(nextTopicPage))]).size,28);
  await sql`UPDATE portable_article_publications SET public_topic='Kit '||article_id
    WHERE workspace_id=${w} AND published_revision IS NOT NULL`;
  assert.doesNotMatch(await read(path+'/'+current),/<h2>More in/);
  const firstTopics=await read(topics);
  const nextTopics=/href="([^"]+)">More topics/.exec(firstTopics)[1].replaceAll('&amp;','&');
  const topicIds=html=>[...html.matchAll(/>Kit ([0-9a-f-]{36})<\/a>/g)].map(match=>match[1]);
  assert.equal(topicIds(firstTopics).length,25);
  const oneTopic=path+'?topic=Kit+'+topicIds(firstTopics)[0];
  assert.equal(titles(await read(oneTopic+'&q=field')).length,1);
  assert.equal(titles(await read(oneTopic+'&q=fielld')).length,1);
  const secondTopics=await read(nextTopics);
  assert.equal(topicIds(secondTopics).length,3);
  assert.equal(new Set([...topicIds(firstTopics),...topicIds(secondTopics)]).size,28);
  await verifyCategoryPages({request,origin,headers,other,sql,workspaceId:w});
  await verifyCustomerCasePortal({request,origin,headers,other,sql,center,unrelated:unrelated.center});

  // Exercise the public URL against an established library with a few similarly spelled guides.
  await sql`WITH a AS (
    INSERT INTO portable_knowledge_articles(workspace_id,id,content,excerpt,search_text,revision,created_at,updated_at)
    SELECT ${w},gen_random_uuid(),jsonb_build_object('title',title,'subtitle','','bodyHtml','<p>Field equipment</p>'),'',
      lower(title)||' field equipment',1,n,n FROM generate_series(1,10000) n
      CROSS JOIN LATERAL (SELECT CASE WHEN n<=7 THEN 'Fluorometer setup '||n ELSE 'Field guide '||md5(n::text) END AS title) labels
    RETURNING workspace_id,id,content,search_text
  ), v AS (
    INSERT INTO portable_knowledge_versions(workspace_id,article_id,revision,content,action,saved_at,changed_by_id)
    SELECT a.workspace_id,a.id,1,a.content,'created',0,w.owner_id FROM a JOIN private_workspaces w ON w.id=a.workspace_id
    RETURNING article_id
  ) INSERT INTO portable_article_publications(workspace_id,article_id,published_revision,revision,search_text,public_topic)
    SELECT a.workspace_id,a.id,1,1,a.search_text,CASE WHEN a.search_text LIKE 'fluorometer%' THEN 'Water testing' ELSE 'Library' END
    FROM a JOIN v ON v.article_id=a.id`;
  await sql`VACUUM (ANALYZE) portable_article_publications`;
  await sql`VACUUM (ANALYZE) portable_knowledge_articles`;
  await sql`ANALYZE portable_knowledge_versions`;
  const [guide]=await sql`SELECT article_id FROM portable_article_publications WHERE workspace_id=${w} AND public_topic='Water testing' LIMIT 1`;
  const started=performance.now();
  await Promise.all(Array.from({length:50},async(_,n)=>{
    const mine=n%2===0;
    const html=await read(mine?path+'/'+guide.article_id:'/help/'+unrelated.center.id+'/'+foreign);
    if(mine){
      assert.equal([...html.matchAll(/>Fluorometer setup \d+<\/a>/g)].length,5);
      assert.doesNotMatch(html,/Other center instructions/);
    }else{
      assert.match(html,/<h1>Other center instructions<\/h1>/);
      assert.doesNotMatch(html,/Fluorometer setup|More in/);
    }
  }));
  console.log('50 concurrent public article reads across two centers:',Math.round(performance.now()-started),'ms');
  const times=[];
  for(let n=0;n<5;n++){
    const start=performance.now();
    const page=await read(path+'?q=fluoromter+setup');
    times.push(Math.round(performance.now()-start));
    assert.match(page,/Similar articles/);
    assert.equal([...page.matchAll(/>Fluorometer setup \d+<\/a>/g)].length,5);
    assert.doesNotMatch(page,/More articles/);
  }
  const {tsImport}=await import('tsx/esm/api');
  const {publicHelp}=await tsImport('../db/postgres/help-center-store.ts',import.meta.url);
  const {drizzle}=await import('drizzle-orm/postgres-js');
  let lookup,neighbors;
  const db=drizzle(sql,{logger:{logQuery(statement,params){
    if(statement.includes('public.strict_word_similarity'))lookup={statement,params};
    if(params.includes('Water testing'))neighbors={statement,params};
  }}});
  assert.equal((await publicHelp(db,center.id,{q:'fluoromter setup'})).suggested,true);
  const guidePage=await publicHelp(db,center.id,{article:guide.article_id});
  assert.equal(guidePage.related.length,5);
  assert.ok(guidePage.related.every(row=>row.body===''));
  assert.ok(neighbors);
  const neighborPlan=await sql.unsafe('EXPLAIN '+neighbors.statement,neighbors.params);
  assert.match(neighborPlan.map(row=>row['QUERY PLAN']).join('\n'),/portable_public_topic_articles/);
  const {listPortableArticles}=await tsImport('../db/postgres/knowledge-store.ts',import.meta.url);
  const [owner]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${w}`;
  let query;
  const reader=drizzle(sql,{logger:{logQuery(statement,params){query={statement,params};}}});
  const matching=await listPortableArticles(reader,owner.owner_id,{match:'words',q:'equipment fluorometer',status:'draft'});
  assert.equal(matching.items.length,7);
  const staffPlan=await sql.unsafe('EXPLAIN (ANALYZE,BUFFERS) '+query.statement,query.params);
  const report=staffPlan.map(row=>row['QUERY PLAN']).join('\n');
  assert.match(report,/portable_knowledge_text_search/);
  console.log('Staff article search across 10,000 fictional editions:',report.match(/Execution Time: [^\n]+/)?.[0]);
  assert.ok(lookup);
  const plan=await sql.unsafe('EXPLAIN '+lookup.statement,lookup.params);
  assert.match(plan.map(row=>row['QUERY PLAN']).join('\n'),/portable_published_article_search/);
  console.log('Published help search across 10,000 fictional editions, misspelled two-word request (ms):',times);

}

async function publishAndBrowseTopics({origin,headers,path,id}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const owner=await browser.newPage(),visitor=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await owner.context().addCookies([{name,value,url:origin}]);
    await owner.goto(origin+'/?view=knowledge&article='+id);
    const field=owner.getByRole('textbox',{name:'Public topic (optional)'});
    await field.fill('Retired topic');
    await owner.getByRole('button',{name:'Publish saved version 1'}).click();
    await owner.getByText('Article published.',{exact:true}).waitFor();
    await field.fill('Field repairs');
    await owner.getByRole('button',{name:'Update public topic'}).click();
    await owner.getByText('Public topic updated.',{exact:true}).waitFor();
    await visitor.goto(origin+path);
    await visitor.getByRole('link',{name:'Browse topics'}).click();
    await visitor.getByRole('link',{name:'Field repairs'}).click();
    await visitor.getByRole('searchbox').fill('connector');
    await visitor.getByRole('button',{name:'Search'}).click();
    assert.equal(new URL(visitor.url()).searchParams.get('topic'),'Field repairs');
    await visitor.getByRole('link',{name:'Battery replacement'}).click();
    assert.equal(new URL(visitor.url()).pathname,path+'/'+id);
    await visitor.getByRole('link',{name:'Field repairs'}).click();
    await visitor.getByRole('heading',{name:'Field repairs'}).waitFor();
  }finally{await browser.close();}
}
