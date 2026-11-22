import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyCategoryPages({request,origin,headers,other,sql,workspaceId}){
  const api='/api/knowledge-base',categories=api+'/categories',library='/?view=knowledge';
  const read=async(path,auth=headers)=>{
    const response=await request(path,{headers:auth});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const save=async(path,body)=>{
    const response=await request(path,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).item;
  };
  await sql`INSERT INTO portable_knowledge_categories(workspace_id,id,name,name_key,description,revision,created_at,updated_at)
    SELECT ${workspaceId},gen_random_uuid(),label,lower(label),'',1,1,1 FROM generate_series(1,225) n
    CROSS JOIN LATERAL (SELECT 'Catalog '||lpad(n::text,3,'0') AS label) x`;
  await sql`INSERT INTO portable_knowledge_categories(workspace_id,id,name,name_key,description,revision,created_at,updated_at,archived_at)
    SELECT ${workspaceId},gen_random_uuid(),label,lower(label),'',1,1,1,2 FROM generate_series(1,205) n
    CROSS JOIN LATERAL (SELECT 'Archived catalog '||lpad(n::text,3,'0') AS label) x`;
  const target=await save(categories,{action:'save',id:randomUUID(),revision:0,name:'ZZ Parts 50%_off'});
  const archived=await save(categories,{action:'save',id:randomUUID(),revision:0,name:'ZZ Retired category'});
  await save(categories,{action:'archive',id:archived.id,revision:1,archived:true});
  const first=await read(categories);
  assert.equal(first.items.length,200);
  const second=await read(categories+'?'+new URLSearchParams(first.next));
  assert.ok(second.items.some(item=>item.id===target.id));
  const ids=[...first.items,...second.items].map(item=>item.id);
  assert.equal(new Set(ids).size,ids.length);
  const literal=categories+'?q='+encodeURIComponent('50%_off');
  assert.deepEqual((await read(literal)).items.map(item=>item.id),[target.id]);
  assert.deepEqual((await read(literal,other)).items,[]);

  const source=await save(api,{action:'save',id:randomUUID(),revision:0,content:{title:'Fictional parts procedure',subtitle:'',
    category:'',categoryId:target.id,tags:[],bodyHtml:'<p>Check the fitting.</p>'}});
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+library);
    await page.getByLabel('Search articles',{exact:true}).fill('50%_off FITTING procédure');
    await page.getByRole('button',{name:'Find articles'}).click();
    await page.getByText('No articles match this view.').waitFor();
    await page.getByLabel('Search matching').selectOption('words');
    await page.getByRole('button',{name:'Find articles'}).click();
    await page.getByRole('link',{name:source.content.title,exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('match'),'words');
    const searchPath=api+'?match=words&q='+encodeURIComponent('50%_off fitting procedure');
    assert.deepEqual((await read(searchPath,other)).items,[]);
    assert.deepEqual((await read(api+'?match=words&q='+encodeURIComponent('40%_off fitting procedure'))).items,[]);
    await page.goto(origin+library+'&match=words&q=guide+instructions+field');
    await page.getByRole('link',{name:'Next page',exact:true}).click();
    assert.equal(await page.getByLabel('Search matching').inputValue(),'words');
    assert.equal(await page.getByLabel('Search articles',{exact:true}).inputValue(),'guide instructions field');
    await page.getByRole('link',{name:'First page',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('afterId'),null);
    await page.goto(origin+library+'&article=new&copyOf='+source.id);
    const picker=page.getByRole('group',{name:'Category choices'});
    const selected=picker.getByRole('combobox');
    assert.equal(await selected.inputValue(),target.id);
    assert.equal(await selected.locator('option:checked').innerText(),target.name);
    await picker.getByRole('button',{name:'More categories'}).click();
    await selected.getByRole('option',{name:'Catalog 026',exact:true}).waitFor({state:'attached'});
    assert.equal(await selected.inputValue(),target.id);
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    await page.getByText('Draft saved.',{exact:true}).waitFor();
    const copyId=new URL(page.url()).searchParams.get('article');
    assert.notEqual(copyId,source.id);
    assert.equal((await read(api+'?id='+copyId)).item.content.categoryId,target.id);

    await page.goto(origin+library);
    const search=async(group,text)=>{
      await group.getByLabel('Find categories').fill(text);
      await group.getByRole('button',{name:'Search categories'}).click();
    };
    await search(picker,'50%_off');
    await selected.selectOption(target.id);
    await page.getByRole('button',{name:'Find articles'}).click();
    await page.getByRole('link',{name:'Copy of Fictional parts procedure'}).waitFor();
    assert.equal(await selected.inputValue(),target.id);
    await selected.selectOption('');
    await page.getByRole('button',{name:'Find articles'}).click();
    await page.getByText('Manage categories',{exact:true}).click();
    const parent=page.getByRole('group',{name:'Parent choices'});
    await search(parent,'50%_off');
    await parent.getByRole('combobox').selectOption(target.id);
    const form=page.getByRole('form',{name:'New category'});
    await form.getByLabel('Name',{exact:true}).fill('Fictional component group');
    await Promise.all([page.waitForEvent('load'),form.getByRole('button',{name:'Add category'}).click()]);
    assert.equal((await read(categories+'?q=Fictional+component+group')).items[0].parentId,target.id);
    assert.deepEqual((await read(categories+'?topLevel=1&q=Fictional+component+group')).items,[]);
    await page.getByText('Manage categories',{exact:true}).click();
    const active=page.getByRole('region',{name:'Active categories'});
    await search(active,'Fictional component group');
    const row=active.getByRole('row').filter({hasText:'Fictional component group'});
    await Promise.all([page.waitForEvent('load'),row.getByRole('button',{name:'Archive',exact:true}).click()]);
    await page.getByText('Manage categories',{exact:true}).click();
    await page.getByRole('button',{name:'Show archived categories'}).click();
    const retired=page.getByRole('region',{name:'Archived category management'});
    await search(retired,'Fictional component group');
    const restore=retired.getByRole('listitem').filter({hasText:'Fictional component group'}).getByRole('button',{name:'Restore'});
    await Promise.all([page.waitForEvent('load'),restore.click()]);
    assert.equal((await read(categories+'?q=Fictional+component+group')).items[0].parentId,target.id);
  }finally{await browser.close();}
  await sql`INSERT INTO portable_knowledge_categories(workspace_id,id,name,name_key,description,revision,created_at,updated_at)
    SELECT ${workspaceId},gen_random_uuid(),label,lower(label),'',1,1,1 FROM generate_series(1,10000) n
    CROSS JOIN LATERAL (SELECT 'Fictional equipment '||md5(n::text) AS label) x`;
  await sql`VACUUM (ANALYZE) portable_knowledge_categories`;
  const renamed=await save(categories,{action:'save',id:target.id,revision:target.revision,name:'Référence 75%_kit'});
  const lookalike=await save(categories,{action:'save',id:randomUUID(),revision:0,name:'Reference 75 other kit'});
  const unrelated=await save(api,{action:'save',id:randomUUID(),revision:0,content:{title:'Fictional unrelated procedure',subtitle:'',
    category:'',categoryId:lookalike.id,tags:[],bodyHtml:'<p>Unrelated.</p>'}});
  assert.deepEqual((await read(api+'?q='+encodeURIComponent('50%_off'))).items,[]);
  const words=q=>api+'?'+new URLSearchParams({q,match:'words'});
  assert.deepEqual((await read(words('fitting 50%_off'))).items,[]);
  const current=await read(words('75%_kit procedure'));
  assert.ok(current.items.some(row=>row.id===source.id));
  assert.equal(current.items.length,2);
  assert.ok(current.items.every(row=>row.categoryId===target.id));
  const query='?'+new URLSearchParams({q:'reference 75%_kit'});
  const previousPlan=await sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM portable_knowledge_categories
    WHERE workspace_id=${workspaceId} AND strpos(name_key,'reference 75%_kit')>0`;
  const indexedPlan=await sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM portable_knowledge_categories
    WHERE workspace_id=${workspaceId} AND (name_key COLLATE "C") LIKE ${'%reference 75\\%\\_kit%'}`;
  for(const [name,rows] of [['prior',previousPlan],['indexed',indexedPlan]]){
    const result=rows[0]['QUERY PLAN'][0];
    assert.equal(result.Plan['Actual Rows'],1);
    console.log('Category lookup ('+name+'): '+result.Plan['Node Type']+', '+result.Plan['Shared Hit Blocks']+
      ' cached pages, '+result['Execution Time']+' ms');
  }
  const scans=async()=>Number((await sql`SELECT idx_scan FROM pg_stat_user_indexes
    WHERE indexrelname='portable_knowledge_category_search'`)[0].idx_scan);
  for(const path of [categories,api]){
    const before=await scans();
    // PostgreSQL publishes index counters asynchronously on idle connections.
    for(let attempt=0;attempt<20;attempt++){
      const {items}=await read(path+query);
      if(path===categories)assert.deepEqual(items.map(item=>item.id),[target.id]);
      else{
        assert.equal(items.length,2);
        assert.ok(items.some(item=>item.id===source.id));
        assert.ok(items.every(item=>item.category===renamed.name&&item.categoryId===target.id));
      }
      if(await scans()>before)break;
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    assert.ok(await scans()>before,'Expected an indexed category-name search through '+path);
    assert.deepEqual((await read(path+query,other)).items,[]);
  }
  await sql`UPDATE portable_knowledge_articles SET content=content||'{"categoryId":"old-import","category":"Original label"}'::jsonb
    WHERE workspace_id=${workspaceId} AND id=${unrelated.id}`;
  const legacy=await read(api+'?q=Fictional+unrelated+procedure');
  assert.deepEqual(legacy.items.map(item=>[item.id,item.category]),[[unrelated.id,'Original label']]);
}
