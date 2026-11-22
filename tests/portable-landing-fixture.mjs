import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {verifyLandingEditor} from './portable-landing-editor-fixture.mjs';

export async function verifyLandingPages({request,origin,headers,other,mapDomain,sql}){
  const api='/api/landing-pages',forms='/api/lead-forms',form=randomUUID(),id=randomUUID();
  const post=(url,data,auth=headers,site=origin)=>request(url,{method:'POST',headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(data)});
  const ok=async promise=>{const r=await promise;assert.ok(r.ok,await r.clone().text());return r.json();};
  const read=async(path,status=200,auth={})=>{const r=await request(path,{headers:auth});assert.equal(r.status,status,path);return r.text();};
  const definition={title:'Open house registration',captureContacts:true};
  await ok(post(forms,{action:'save',id:form,revision:0,definition}));
  const draft={title:'Spring open house',slug:'home',description:'Join the workshop.',accent:'#28604a',
    blocks:[{id:randomUUID(),type:'heading',text:'Meet the team'},{id:randomUUID(),type:'text',text:'Bring a colleague.'},
      {id:randomUUID(),type:'quote',text:'We will see you there.'},{id:randomUUID(),type:'form',label:'Register now',formId:form}]};
  const save={action:'save',id,revision:0,draft};
  assert.equal((await post(api,save,{})).status,401);
  assert.equal((await post(api,save,headers,'https://unrelated.example.test')).status,403);
  assert.equal((await post(api,save,other)).status,400);
  const created=await ok(post(api,save));
  const manager='/?view=landing-pages',edit=manager+'&edit='+id,base='/p/'+created.workspaceId+'/',path=base+'home';
  await read(path,404);await read(edit,404,other);
  await read(manager+'&edit=new&copy='+id,404,other);
  await read(edit+'&copy='+id,404,headers);
  assert.match(await read(manager,200,headers),/Private draft/);
  assert.match(await read(edit,200,headers),/Spring open house/);
  const publish={action:'publish',id,revision:created.revision};
  assert.equal((await post(api,publish)).status,409,'Disabled forms prevent publication');
  await ok(post(forms,{action:'setEnabled',id:form,revision:1,enabled:true}));
  const concurrent=await Promise.all([post(api,publish),post(api,publish)]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  const published=await concurrent.find(r=>r.ok).json();
  assert.equal((await post(api,{...publish,revision:published.revision},other)).status,404);
  assert.ok((await read(path)).includes('rel="canonical" href="'+origin+path+'"'));
  const custom=await mapDomain(created.workspaceId);
  const resp=await fetch(custom+'/');assert.equal(resp.status,200);assert.equal(resp.headers.get('cache-control'),'no-store');
  assert.equal(resp.headers.get('set-cookie'),null);
  const html=await resp.text();assert.match(html,/Spring open house/);assert.ok(html.indexOf('Meet the team')<html.indexOf('Bring a colleague'));
  assert.equal(await read(path),html);
  assert.ok(html.includes('rel="canonical" href="'+custom+'/"'));
  assert.doesNotMatch(html,/journey-consent|journey\.js/);
  const attribution='/api/web-attribution';
  const site={id:randomUUID(),name:'Event domain',origin:custom,enabled:true,revision:0};
  await ok(post(attribution,site));
  const tracked=await fetch(custom+'/'),csp=tracked.headers.get('content-security-policy');
  const optedIn=await tracked.text();
  assert.ok(optedIn.includes('data-site="'+site.id+'"')&&optedIn.includes('Allow visit measurement'));
  assert.ok(csp.includes('script-src '+origin+'/journey.js;')&&csp.includes('connect-src '+origin+'/api/public/journey'));
  assert.doesNotMatch(csp,/script-src[^;]*unsafe-inline/);
  const privateVisit=await fetch(custom+'/',{headers:{'sec-gpc':'1'}});
  assert.doesNotMatch(await privateVisit.text(),/journey-consent|journey\.js/);
  assert.doesNotMatch(privateVisit.headers.get('content-security-policy'),/script-src/);
  const neighbor={id:randomUUID(),name:'Second owner',origin,enabled:true,revision:0};
  await ok(post(attribution,neighbor,other));
  assert.equal(await read(path),html,'Canonical registration in another workspace must not enable tracking here');
  await ok(post(attribution,{...site,revision:1,enabled:false}));
  assert.equal(await (await fetch(custom+'/')).text(),html);
  assert.equal((await fetch(custom+'/api/lead-forms',{headers})).status,404);
  assert.equal((await fetch(custom+'/auth/sign-in')).status,404);
  assert.equal((await fetch(custom+'/p/'+created.workspaceId+'/home')).status,404);
  assert.equal((await fetch(custom+'/',{method:'POST'})).status,405);
  const formUrl=/class="cta" href="([^"]+)"/.exec(html)[1];
  assert.equal(formUrl,origin+'/forms/'+form);
  const formPage=await fetch(formUrl);assert.match(await formPage.text(),/Open house registration/);
  const submission={id:randomUUID(),revision:2,payload:{name:'Fictional visitor',email:'open-house@example.test'}};
  for(let attempt=0;attempt<2;attempt++)assert.ok((await ok(post('/api/public/forms/'+form,submission,{}))).accepted);
  const inbox=await ok(request(forms+'?formId='+form,{headers}));
  assert.equal(inbox.results.length,1);assert.equal(inbox.results[0].id,submission.id);assert.ok(inbox.results[0].contactId);
  const changed={...draft,title:'Autumn open house',slug:'autumn',blocks:[...draft.blocks].reverse()};
  const newer=await ok(post(api,{...save,revision:published.revision,draft:changed}));
  for(const q of ['Spring','AUTUMN','home']){
    const filtered=await read(manager+'&status=changed&q='+q,200,headers);
    assert.match(filtered,/aria-label="View live page home"/);
    assert.ok(filtered.includes('href="'+custom+'/"'));
    assert.doesNotMatch(await read(manager+'&status=published&q='+q,200,headers),/aria-label="View live page home"/);
    assert.doesNotMatch(await read(manager+'&status=changed&q='+q,200,other),/aria-label="View live page home"/);
  }
  assert.equal(await read(path),html);
  await read(base+'autumn',404);
  const second=await ok(post(api,{...save,id:randomUUID()}));
  assert.equal((await post(api,{action:'publish',id:second.id,revision:second.revision})).status,409,'Occupied address is preserved');
  const replacement=await ok(post(api,{...publish,revision:newer.revision}));
  await read(path,404);assert.equal((await fetch(custom+'/')).status,404);
  assert.equal(replacement.publicUrl,custom+'/autumn');
  const updated=await read(base+'autumn');assert.ok(updated.indexOf('Register now')<updated.indexOf('Meet the team'));
  assert.equal(await (await fetch(custom+'/autumn')).text(),updated);
  await ok(post(forms,{action:'setEnabled',id:form,revision:2,enabled:false}));
  assert.doesNotMatch(await read(base+'autumn'),/Register now/);
  await ok(post(api,{action:'withdraw',id,revision:replacement.revision}));
  await read(base+'autumn',404);assert.equal((await fetch(custom+'/autumn')).status,404);
  const isolated=await ok(post(api,{...save,id:randomUUID(),draft:{...draft,blocks:[],title:'Other workspace'}},other));
  await ok(post(api,{action:'publish',id:isolated.id,revision:isolated.revision},other));
  assert.match(await read('/p/'+isolated.workspaceId+'/home'),/Other workspace/);assert.equal((await fetch(custom+'/')).status,404);
  const otherLanding=await read('/p/'+isolated.workspaceId+'/home');
  assert.ok(otherLanding.includes('data-site="'+neighbor.id+'"')&&otherLanding.includes('data-paths="/p/'+isolated.workspaceId+'/home"'));
  assert.ok(!(await read(manager+'&edit=new',200,other)).includes(custom),'Another workspace’s domain stays out of the editor');
  await verifyCampaignRedirects({post,ok,headers,other,origin,base,custom});
  const inlineForm=randomUUID(),inlineDefinition={...definition,title:'Clinic registration',embedOrigin:custom};
  await ok(post(forms,{action:'save',id:inlineForm,revision:0,definition:inlineDefinition}));
  await ok(post(forms,{action:'setEnabled',id:inlineForm,revision:1,enabled:true}));
  await ok(post(attribution,{...site,revision:2,enabled:true}));
  await verifyLandingEditor({headers,origin,custom,inlineForm,base,
    stopEmbedding:()=>ok(post(forms,{action:'save',id:inlineForm,revision:2,definition:{...inlineDefinition,embedOrigin:origin}})),
    closeForm:()=>ok(post(forms,{action:'setEnabled',id:inlineForm,revision:3,enabled:false}))});
  const clinic=await ok(request(forms+'?formId='+inlineForm,{headers}));
  assert.equal(clinic.results.length,3);
  assert.ok(clinic.results.every(row=>row.contactId));
  const report=await ok(request(attribution+'?siteId='+site.id,{headers}));
  assert.equal(report.conversions,1);
  assert.equal(report.sources[0].source,'clinic-newsletter');
  await sql`INSERT INTO portable_landing_pages (id,workspace_id,revision,draft_revision,draft)
    SELECT gen_random_uuid(),${created.workspaceId},1,1,
      jsonb_build_object('title','Clinic 50%_'||n,'slug','directory-'||n,'accent','#28604a','blocks','[]'::jsonb,'description','')
    FROM generate_series(1,27) n`;
  await ok(post(api,{...save,id:randomUUID(),draft:{...draft,title:'Clinic 5000',slug:'clinic-other',blocks:[]}}));
  await verifyLandingDirectory({headers,origin});
  // Start this separate publishing journey with a fresh budget for the fictional owner.
  await sql`DELETE FROM portable_request_budgets WHERE scope='api_write' AND subject IN
    (SELECT id FROM login_identities WHERE email='owner@example.test')`;
  await verifyCampaignPageLinks({request,headers,origin,base,custom,post,ok,sql,workspace:created.workspaceId,foreignPage:isolated.id});
  await verifyCampaignSearchAtScale({sql,workspace:created.workspaceId,headers,other,request});
  return {form,id};
}


async function verifyCampaignRedirects({post,ok,headers,other,origin,base,custom}){
  const api='/api/landing-pages',first=randomUUID(),second=randomUUID(),neighbor=randomUUID();
  const save=(id,revision,slug,redirectFrom,auth=headers)=>post(api,{action:'save',id,revision,
    draft:{slug,title:slug,description:'',accent:'#123456',blocks:[],redirectFrom}},auth);
  const publish=(id,revision,auth=headers)=>post(api,{action:'publish',id,revision},auth);
  for(const invalid of [['open-day'],['old','old'],['https://example.org'],['a/b']]){
    assert.equal((await save(first,0,'open-day',invalid)).status,400);
  }
  await ok(save(first,0,'open-day',['old-event']));
  await ok(save(second,0,'old-event',[]));
  const attempts=await Promise.all([publish(first,1),publish(second,1)]);
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  if(attempts[1].ok){
    await ok(post(api,{action:'withdraw',id:second,revision:2}));
    await ok(publish(first,1));
  }
  const foreign=await ok(save(neighbor,0,'other-event',['old-event'],other));
  await ok(publish(neighbor,1,other));
  const query='?utm_source=mail&label=a%2Bb&label=c';
  async function redirect(url,expected,method='GET'){
    const response=await fetch(url+query,{redirect:'manual',method});
    assert.equal(response.status,302);
    assert.equal(response.headers.get('location'),expected+query);
    assert.equal(response.headers.get('cache-control'),'no-store');
  }
  await redirect(origin+'/p/'+foreign.workspaceId+'/old-event','/p/'+foreign.workspaceId+'/other-event');
  await redirect(origin+base+'old-event',base+'open-day','HEAD');
  await redirect(custom+'/old-event','/open-day');
  await ok(save(first,2,'home',['open-day','old-event']));
  await ok(publish(first,3));
  await redirect(custom+'/old-event','/');
  await redirect(custom+'/open-day','/');
  await redirect(origin+base+'old-event',base+'home');
  const conflictRevision=attempts[1].ok?3:1;
  await ok(save(second,conflictRevision,'another-page',['open-day']));
  assert.equal((await publish(second,conflictRevision+1)).status,409);
  await ok(save(first,4,'home',['old-event']));
  await redirect(custom+'/open-day','/');
  await ok(publish(first,5));
  assert.equal((await fetch(custom+'/open-day',{redirect:'manual'})).status,404);
  await ok(publish(second,conflictRevision+1));
  await redirect(custom+'/open-day','/another-page');
  await ok(post(api,{action:'withdraw',id:first,revision:6}));
  assert.equal((await fetch(custom+'/old-event',{redirect:'manual'})).status,404);
  await redirect(origin+'/p/'+foreign.workspaceId+'/old-event','/p/'+foreign.workspaceId+'/other-event');
}

async function verifyLandingDirectory({headers,origin}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=landing-pages');
    const filters=page.getByRole('form',{name:'Filter landing pages'});
    await filters.getByRole('searchbox').fill('50%_');
    await filters.getByLabel('Publication status').selectOption('draft');
    await filters.getByRole('button',{name:'Apply'}).click();
    const titles=page.locator('tbody tr td:first-child a');
    assert.equal(await titles.count(),25);
    await page.getByRole('link',{name:'More pages'}).click();
    await page.getByRole('link',{name:'First page',exact:true}).waitFor();
    const saved=page.url();
    assert.equal(await titles.count(),2);
    const record=await titles.first().textContent();
    await titles.first().click();
    await page.getByRole('heading',{name:record,exact:true}).waitFor();
    await page.getByRole('link',{name:'Landing pages',exact:true}).filter({visible:true}).click();
    await filters.waitFor();
    assert.equal(page.url(),saved);
    await filters.getByRole('searchbox').fill('another campaign');
    await filters.getByRole('button',{name:'Apply'}).click();
    await page.getByText('No landing pages match these filters.').waitFor();
    assert.equal(new URL(page.url()).searchParams.has('after'),false);
    await page.getByRole('link',{name:'Clear filters'}).click();
    await page.getByRole('link',{name:'Clear filters'}).waitFor({state:'hidden'});
    assert.equal(await filters.getByRole('searchbox').inputValue(),'');
    assert.equal(await filters.getByLabel('Publication status').inputValue(),'');
    const overflow=await page.evaluate(()=>[...document.querySelectorAll('main *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1)
      .slice(0,6).map(el=>[el.tagName,el.className,el.getBoundingClientRect().width,getComputedStyle(el).tableLayout,getComputedStyle(el).whiteSpace]));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Landing page directory overflow: '+JSON.stringify(overflow));
  }finally{await browser.close();}
}

async function verifyCampaignPageLinks({request,headers,origin,base,custom,post,ok,sql,workspace,foreignPage}){
  const api='/api/landing-pages',target=randomUUID(),label='See the event schedule';
  const draft={title:'Event schedule',slug:'home',description:'Open sessions',accent:'#235451',blocks:[]};
  const save=(id,revision,content)=>post(api,{action:'save',id,revision,draft:content});
  const publish=(id,revision)=>ok(post(api,{action:'publish',id,revision}));
  await ok(save(target,0,draft));
  const live=await publish(target,1);
  const renamed={...draft,slug:'november-schedule',title:'November schedule'};
  const edited=await ok(save(target,live.revision,renamed));
  assert.equal((await request(api+'?q=schedule')).status,401);
  assert.deepEqual((await ok(request(api+'?q=November+schedule',{headers}))).items,[]);
  const choice=await ok(request(api+'?q=Event+schedule&current='+foreignPage,{headers}));
  assert.deepEqual(choice.items,[{id:target,title:draft.title,slug:'home'}]);
  assert.equal(choice.current,null);
  // Use the previously seeded 27 drafts to exercise a multi-page target directory.
  await sql`WITH released AS (
    UPDATE portable_landing_pages SET last_published=draft,revision=revision+1
    WHERE workspace_id=${workspace} AND draft->>'slug' LIKE 'directory-%'
    RETURNING workspace_id,id,draft->>'slug' AS slug,draft_revision
  ) INSERT INTO portable_landing_publications(workspace_id,page_id,slug,revision)
    SELECT workspace_id,id,slug,draft_revision FROM released`;
  const query=api+'?q='+encodeURIComponent('Clinic 50%_')+'&current='+target;
  const first=await ok(request(query,{headers}));
  assert.equal(first.items.length,25);
  assert.equal(first.current.id,target);
  const second=await ok(request(query+'&after='+first.next,{headers}));
  assert.equal(second.items.length,2);
  assert.equal(second.next,null);
  assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,27);
  for(const pageId of [foreignPage,target]){
    const block={type:'button',id:randomUUID(),label,target:{pageId}};
    assert.equal((await save(target,edited.revision,{...renamed,blocks:[block]})).status,400);
  }
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const staff=await browser.newPage({viewport:{width:390,height:844}}),visitor=await browser.newPage();
    const [name,value]=headers.cookie.split('=');
    await staff.context().addCookies([{name,value,url:origin}]);
    await staff.goto(origin+'/?view=landing-pages&edit=new');
    await staff.getByLabel('Page title',{exact:true}).fill('Session guide');
    await staff.getByLabel('Page address',{exact:true}).fill('session-guide');
    await staff.getByRole('button',{name:'Add call to action'}).click();
    await staff.getByLabel('Button text').fill(label);
    await staff.getByLabel('Button destination').selectOption('page');
    const search=staff.getByLabel('Find a landing page');
    await search.fill('Clinic 50%_');
    await staff.getByRole('button',{name:'More pages',exact:true}).click();
    await staff.getByLabel('Linked landing page').selectOption(second.items[1].id);
    await staff.getByRole('button',{name:'First pages',exact:true}).click();
    await search.fill('Event schedule');
    await staff.getByLabel('Linked landing page').selectOption({label:'Event schedule · /home'});
    await staff.getByRole('button',{name:'Save draft'}).click();
    await staff.getByText('Draft saved.',{exact:true}).waitFor();
    await staff.getByRole('button',{name:'Publish saved page'}).click();
    await staff.getByText('Page published.',{exact:true}).waitFor();
    async function follow(host,path,expectedTitle){
      await visitor.goto(host+'session-guide');
      const cta=visitor.getByRole('link',{name:label,exact:true});
      assert.equal(await cta.getAttribute('href'),path);
      await cta.click();
      await visitor.getByRole('heading',{name:expectedTitle,exact:true}).waitFor();
    }
    await follow(custom+'/','/',draft.title);
    await follow(origin+base,base+'home',draft.title);
    const moved=await publish(target,edited.revision);
    await follow(custom+'/','/'+renamed.slug,renamed.title);
    await follow(origin+base,base+renamed.slug,renamed.title);
    const closed=await ok(post(api,{action:'withdraw',id:target,revision:moved.revision}));
    const reuse=randomUUID();
    await ok(save(reuse,0,{...draft,title:'Different event',slug:renamed.slug}));
    const reused=await publish(reuse,1);
    await visitor.goto(custom+'/session-guide');
    assert.equal(await visitor.getByRole('link',{name:label}).count(),0);
    await staff.reload();
    await staff.getByRole('option',{name:'Previously selected page (unpublished)'}).waitFor({state:'attached'});
    await staff.getByLabel('Introduction').fill('Current sessions');
    await staff.getByRole('button',{name:'Save draft'}).click();
    await staff.getByText('Draft saved.',{exact:true}).waitFor();
    await staff.getByRole('button',{name:'Publish saved page'}).click();
    await staff.getByRole('alert').filter({hasText:'Publish each linked landing page'}).waitFor();
    await ok(post(api,{action:'withdraw',id:reuse,revision:reused.revision}));
    await publish(target,closed.revision);
    await follow(custom+'/','/'+renamed.slug,renamed.title);
    await staff.getByRole('button',{name:'Publish saved page'}).click();
    await staff.getByText('Page published.',{exact:true}).waitFor();
  }finally{await browser.close();}
}

async function verifyCampaignSearchAtScale({sql,workspace,headers,other,request}){
  // Rehearse the index-only upgrade on a populated disposable catalog.
  const migration=await readFile(new URL('../db/postgres/migrations/0232_landing_search.sql',import.meta.url),'utf8');
  await sql`DROP INDEX portable_landing_search`;
  await sql`WITH catalog AS (
    SELECT n,gen_random_uuid() AS id,jsonb_build_object('title',CASE WHEN n=1 THEN 'Draft replacement' ELSE 'Campaign '||n END,
      'slug','campaign-'||n) AS draft,jsonb_build_object('title','Launch '||n,'slug',CASE WHEN n<=2 THEN 'orchard-'||n ELSE 'edition-'||n END,
      'redirectFrom',jsonb_build_array('previous-edition-'||n)) AS snapshot
    FROM generate_series(1,50000) n
  ), pages AS (
    INSERT INTO portable_landing_pages(id,workspace_id,revision,draft_revision,draft,last_published)
    SELECT id,${workspace},3,2,draft,snapshot FROM catalog
    RETURNING id,workspace_id,last_published
  ) INSERT INTO portable_landing_publications(page_id,workspace_id,revision,slug)
    SELECT id,workspace_id,1,last_published->>'slug' FROM pages WHERE last_published->>'slug'<>'orchard-2'`;
  const started=performance.now();
  await sql.unsafe(migration);
  const elapsed=Math.round(performance.now()-started);
  const [{size}]=await sql`SELECT pg_size_pretty(pg_relation_size('portable_landing_search')) AS size`;
  console.log('Built campaign index on 50,000 fictional pages in '+elapsed+' ms, using '+size+'.');
  await sql`VACUUM (ANALYZE) portable_landing_pages`;
  await sql`VACUUM (ANALYZE) portable_landing_publications`;
  const oldPath='/p/'+workspace+'/previous-edition-45000';
  const redirectIndexScans=async()=>Number((await sql`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname='portable_landing_redirects'`)[0].idx_scan);
  const initialScans=await redirectIndexScans();
  for(let i=0;i<15;i++){
    const response=await request(oldPath);
    assert.equal(response.status,302);
    assert.equal(response.headers.get('location'),'/p/'+workspace+'/edition-45000');
    if(await redirectIndexScans()>initialScans)break;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.ok(await redirectIndexScans()>initialScans,'The public request should find the previous address using its index');
  async function check(picker,auth=headers){
    const path=picker?'/api/landing-pages?q=ORCHARD':'/?view=landing-pages&q=ORCHARD';
    const r=await request(path,{headers:auth});
    assert.equal(r.status,200);
    if(picker){
      const {items}=await r.json();
      assert.deepEqual(items.map(page=>page.slug),auth===headers?['orchard-1']:[]);
    }else{
      const html=await r.text();
      assert.equal(html.includes('aria-label="View live page orchard-1"'),auth===headers);
      assert.ok(!html.includes('>Campaign 2</a>'),'withdrawn addresses must not match');
    }
  }
  for(const picker of [false,true]){
    await check(picker,other);
    const index='portable_landing_search';
    const scans=async()=>Number((await sql`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname=${index}`)[0].idx_scan);
    const before=await scans(),durations=[];
    for(let i=0;i<6;i++){
      const start=performance.now();
      await check(picker);
      if(i)durations.push(performance.now()-start);
    }
    for(let i=0;i<12&&await scans()===before;i++){
      await new Promise(resolve=>setTimeout(resolve,200));
      await check(picker);
    }
    assert.ok(await scans()>before,'The '+(picker?'picker':'directory')+' should use the campaign search index');
    console.log((picker?'Published page picker':'Landing page directory')+' selective search, 50,000 campaign pages, median of five: '+
      Math.round(durations.sort((a,b)=>a-b)[2])+' ms.');
  }
}
