import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPortableKnowledge({request,origin,headers,other,sql,sharing}){
  const api='/api/knowledge-base';
  const id=randomUUID();
  const detail=api+'?id='+id;
  const content={
    title:'Fictional onboarding checklist',subtitle:'Fictional setup',category:'Guides',tags:['Café'],
    bodyHtml:'<h1>Welcome</h1><p onclick="alert(1)">Read the <strong>checklist</strong>.</p><script>alert(1)</script><a href="javascript:alert(1)">Next step</a>',
  };
  const initial={action:'save',id,revision:0,content};
  const read=(path=api,auth=headers)=>request(path,{headers:auth});
  const copyPath=source=>'/?view=knowledge&article=new&copyOf='+source;
  const post=(input,auth=headers,site=origin)=>request(api,{
    method:'POST',headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(input),
  });
  const [workspace]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${sharing.workspaceId}`;
  await sql`DELETE FROM portable_request_budgets WHERE scope='api_write' AND subject=${workspace.owner_id}`;

  assert.equal((await read(api,{})).status,401);
  assert.equal((await post(initial,headers,'https://outside.example.test')).status,403);
  assert.equal((await post({...initial,content:{...content,categoryId:randomUUID()}})).status,409,'an unknown managed category is refused');
  const landing=await read('/');
  assert.match(await landing.text(),/href="\/\?view=knowledge"/);
  const empty=await read('/?view=knowledge');
  assert.equal(empty.status,200);
  assert.match(await empty.text(),/No articles match this view/);
  const newArticle=await read('/?view=knowledge&article=new');
  assert.equal(newArticle.status,200);
  assert.match(await newArticle.text(),/Article body/);

  const creates=await Promise.all([post(initial),post(initial)]);
  assert.deepEqual(creates.map(result=>result.status),[200,200]);
  const created=await Promise.all(creates.map(result=>result.json()));
  assert.deepEqual(created[0],created[1]);
  assert.equal(created[0].item.revision,1);
  assert.equal(created[0].item.content.bodyHtml,'<h2>Welcome</h2><p>Read the <strong>checklist</strong>.</p>Next step');
  const savedScreen=await read('/?view=knowledge&article='+id);
  assert.equal(savedScreen.status,200);
  assert.match(await savedScreen.text(),/Fictional onboarding checklist/);
  const search=await (await read(api+'?q=cafe')).json();
  assert.equal(search.items[0].id,id);
  assert.equal('content' in search.items[0],false,'List must only carry summary fields');
  assert.equal((await read(api+'?afterAt=1')).status,400);
  assert.equal((await read(api+'?q=one&q=two')).status,400);
  assert.equal((await read(detail,other)).status,404);
  assert.equal((await read(detail+'&history=1',other)).status,404);
  assert.equal((await read(detail+'&version=1',other)).status,404);
  assert.equal((await read('/?view=knowledge&article='+id,other)).status,404);
  assert.equal((await read(api+'?workspaceId='+sharing.workspaceId,other)).status,400);
  assert.equal((await post({...initial,revision:1},other)).status,404);
  assert.deepEqual(await (await read(api,other)).json(),{items:[],next:null});

  const edits=['Fictional edit A','Fictional edit B'].map(title=>({
    ...initial,revision:1,content:{...content,title},
  }));
  const concurrent=await Promise.all(edits.map(edit=>post(edit)));
  assert.deepEqual(concurrent.map(result=>result.status).sort(),[200,409]);
  const [winner]=concurrent.filter(result=>result.status===200);
  const saved=(await winner.json()).item;
  assert.equal(saved.revision,2);
  assert.equal((await post(edits.find(edit=>edit.content.title===saved.content.title))).status,200);
  const history=await (await read(detail+'&history=1')).json();
  assert.deepEqual(history.items.map(({revision,action,current})=>[revision,action,current]),[[2,'saved',true],[1,'created',false]]);
  assert.equal('content' in history.items[0],false);
  const version=await (await read(detail+'&version=1')).json();
  assert.deepEqual(version.item.content,created[0].item.content);
  const restore={action:'restore',id,revision:2,sourceRevision:1};
  const restored=(await (await post(restore)).json()).item;
  assert.equal(restored.revision,3);
  assert.deepEqual(restored.content,version.item.content);
  assert.deepEqual((await (await post(restore)).json()).item,restored);
  const archive={action:'archive',id,revision:3,archived:true};
  const archived=(await (await post(archive)).json()).item;
  assert.ok(archived.archivedAt);
  assert.deepEqual((await (await post(archive)).json()).item,archived);
  assert.equal((await read(copyPath(id))).status,404,'an archived article can’t be duplicated');
  assert.equal((await post({...initial,revision:4})).status,409);
  assert.deepEqual(await (await read()).json(),{items:[],next:null});
  assert.equal((await (await read(api+'?status=archived')).json()).items[0].id,id);
  const draft=(await (await post({...archive,revision:4,archived:false})).json()).item;
  assert.equal(draft.revision,5);
  assert.equal(draft.archivedAt,null);

  // Duplicate draft opens an unsaved editor from an owner-scoped read; only Save draft creates the copy.
  const rows=async()=>(await sql`SELECT count(*)::int AS n FROM portable_knowledge_articles WHERE workspace_id=${sharing.workspaceId}`)[0].n;
  const rowsBefore=await rows();
  const copyScreen=await read(copyPath(id));
  assert.equal(copyScreen.status,200);
  const copyHtml=await copyScreen.text();
  assert.match(copyHtml,/Duplicate draft/);
  assert.match(copyHtml,/value="Copy of Fictional onboarding checklist"/);
  assert.match(copyHtml,/value="Fictional setup"/);
  assert.match(copyHtml,/value="Café"/);
  assert.match(copyHtml,/Nothing is saved until you click Save draft/);
  assert.equal(await rows(),rowsBefore,'opening a copy writes nothing');
  for(const path of [copyPath(randomUUID()),copyPath('not-a-uuid'),'/?view=knowledge&copyOf='+id,
    '/?view=knowledge&article='+id+'&copyOf='+id])assert.equal((await read(path)).status,404,path);
  assert.equal((await read(copyPath(id),other)).status,404,'a foreign article can’t be duplicated');
  const copyId=randomUUID();
  const copySave={action:'save',id:copyId,revision:0,content:{...draft.content,title:'Copy of '+draft.content.title}};
  const copies=await Promise.all([post(copySave),post(copySave)]);
  assert.deepEqual(copies.map(result=>result.status),[200,200],'a retried copy save is idempotent');
  const copied=(await copies[0].json()).item;
  assert.equal(copied.id,copyId);
  assert.equal(copied.revision,1);
  assert.deepEqual({...copied.content,title:draft.content.title},draft.content);
  assert.equal(await rows(),rowsBefore+1);
  assert.deepEqual((await (await read(detail)).json()).item,draft,'the source is untouched');
  assert.equal((await (await read(detail+'&history=1')).json()).items.length,5);
  assert.equal((await post({...copySave,revision:1,content:{...copySave.content,subtitle:'Fictional copy edit'}})).status,200);
  assert.deepEqual((await (await read(detail)).json()).item,draft,'editing the copy leaves the source alone');
  assert.equal((await post({action:'archive',id:copyId,revision:2,archived:true})).status,200);

  // Long titles stay within the cap; an inactive managed category is cleared rather than carried.
  const longId=randomUUID();
  const longTitle='L'.repeat(200);
  await sql`INSERT INTO portable_knowledge_articles(workspace_id,id,content,excerpt,search_text,revision,created_at,updated_at)
    VALUES(${sharing.workspaceId},${longId},${JSON.stringify({title:longTitle,subtitle:'',category:'',categoryId:randomUUID(),tags:['Fictional'],bodyHtml:'<p>Fictional</p>'})}::jsonb,
      '','long',1,1000,1000)`;
  const longHtml=await (await read(copyPath(longId))).text();
  assert.match(longHtml,new RegExp('value="'+('Copy of '+longTitle).slice(0,200)+'"'));
  assert.match(longHtml,/original category is no longer active/);
  assert.doesNotMatch(longHtml,/Archived category/);
  await sql`DELETE FROM portable_knowledge_articles WHERE workspace_id=${sharing.workspaceId} AND id=${longId}`;

  const additional=Array.from({length:27},()=>randomUUID());
  const sameTime=1_000;
  await sql`INSERT INTO portable_knowledge_articles(workspace_id,id,content,excerpt,search_text,revision,created_at,updated_at)
    SELECT ${sharing.workspaceId},id,'{"title":"Fictional paged article","category":"Guides"}'::jsonb,'','paged',1,${sameTime},${sameTime}
    FROM unnest(${additional}::uuid[]) AS id`;
  const first=await (await read(api+'?q=paged')).json();
  assert.equal(first.items.length,25);
  assert.ok(first.next);
  const second=await (await read(api+'?'+new URLSearchParams({q:'paged',...first.next}))).json();
  assert.equal(second.items.length,2);
  assert.equal(second.next,null);
  assert.deepEqual([...first.items,...second.items].map(item=>item.id),additional.sort().reverse());

  await sql`DELETE FROM portable_knowledge_articles WHERE workspace_id=${sharing.workspaceId} AND id IN ${sql(additional)}`;
  return async (instance=request,owner=headers,outsider=other)=>{
    const readInstance=(path,auth=owner)=>instance(path,{headers:auth});
    assert.deepEqual((await (await readInstance(detail)).json()).item,draft);
    const after=await (await readInstance(detail+'&history=1')).json();
    assert.deepEqual(after.items.map(({revision,action})=>[revision,action]),
      [[5,'unarchived'],[4,'archived'],[3,'restored'],[2,'saved'],[1,'created']]);
    assert.ok(after.items.every(item=>item.changedById===workspace.owner_id));
    assert.deepEqual((await (await readInstance(detail+'&version=1')).json()).item,version.item);
    assert.equal((await readInstance(detail,outsider)).status,404);
    assert.equal((await readInstance(detail+'&history=1',outsider)).status,404);
  };
}

// Managed categories: nesting, unique names, archive guards and article filtering.
export async function verifyPortableKnowledgeCategories({request,origin,headers,other,sql,workspaceId}){
  const api='/api/knowledge-base',categories=api+'/categories';
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const post=(path,input,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(input)});
  const save=async input=>{
    const response=await post(categories,{action:'save',revision:0,...input});
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).item;
  };
  const list=async(status='active')=>(await (await request(categories+'?status='+status,{headers})).json()).items;
  const marker='Fictional '+randomUUID().slice(0,6);
  const guides=await save({id:randomUUID(),name:marker+' Guides',description:'How-to articles'});
  const setupId=randomUUID();
  const setup=await save({id:setupId,name:'Setup',parentId:guides.id});
  assert.deepEqual(await save({id:setupId,name:'Setup',parentId:guides.id}),setup,'a repeated create returns the category');
  assert.equal((await post(categories,{action:'save',id:randomUUID(),revision:0,name:'setup',parentId:guides.id})).status,409,'names are unique per parent');
  assert.equal((await post(categories,{action:'save',id:randomUUID(),revision:0,name:'Deeper',parentId:setup.id})).status,400,'one level of subcategories');
  assert.equal((await post(categories,{action:'save',id:guides.id,revision:guides.revision,name:guides.name,parentId:randomUUID()})).status,400);
  const otherId=randomUUID();
  assert.equal((await post(categories,{action:'save',id:otherId,revision:0,name:marker+' Other'},other)).status,200,'the member has their own categories');
  assert.ok(!(await list()).some(row=>row.id===otherId));
  let rows=await list();
  assert.equal(rows.find(row=>row.id===setup.id)?.parentName,guides.name);

  // Articles use a managed category; its name is searchable and filterable.
  const articleId=randomUUID();
  const content={title:marker+' article',subtitle:'',category:'Ignored text',categoryId:setup.id,tags:[],bodyHtml:'<p>Fictional body</p>'};
  const created=await post(api,{action:'save',id:articleId,revision:0,content});
  assert.equal(created.status,200,await created.clone().text());
  assert.equal((await created.json()).item.content.category,'');
  const filtered=await (await request(api+'?'+new URLSearchParams({categoryId:setup.id}),{headers})).json();
  assert.deepEqual(filtered.items.map(item=>[item.id,item.category]),[[articleId,'Setup']]);
  assert.ok((await (await request(api+'?'+new URLSearchParams({q:'setup'}),{headers})).json()).items.some(item=>item.id===articleId));
  rows=await list();
  assert.equal(rows.find(row=>row.id===setup.id)?.articleCount,1);
  const renamed=await post(categories,{action:'save',id:setup.id,revision:setup.revision,name:'Installation',parentId:guides.id});
  assert.equal(renamed.status,200);
  setup.revision=(await renamed.json()).item.revision;
  assert.ok((await (await request(api+'?'+new URLSearchParams({q:'installation'}),{headers})).json()).items.some(item=>item.id===articleId),
    'search follows a category rename');
  assert.ok(!(await (await request(api+'?q=setup',{headers})).json()).items.some(item=>item.id===articleId),
    'the previous managed category name stops matching');

  // A category in use, or with active subcategories, can't be archived.
  assert.equal((await post(categories,{action:'archive',id:setup.id,revision:setup.revision,archived:true})).status,409);
  assert.equal((await post(categories,{action:'archive',id:guides.id,revision:guides.revision,archived:true})).status,409);
  const archiveArticle=await post(api,{action:'archive',id:articleId,revision:1,archived:true});
  assert.equal(archiveArticle.status,200,await archiveArticle.clone().text());
  const archived=await post(categories,{action:'archive',id:setup.id,revision:setup.revision,archived:true});
  assert.equal(archived.status,200);
  const archivedSetup=(await archived.json()).item;
  assert.ok((await list('archived')).some(row=>row.id===setup.id));
  assert.equal((await post(api,{action:'archive',id:articleId,revision:2,archived:false})).status,409,
    'unarchiving an article requires an active category');
  assert.equal((await post(api,{action:'save',id:randomUUID(),revision:0,content})).status,409,'an archived category can’t be chosen');
  const parentArchive=await post(categories,{action:'archive',id:guides.id,revision:guides.revision,archived:true});
  assert.equal(parentArchive.status,200);
  assert.equal((await post(categories,{action:'archive',id:setup.id,revision:archivedSetup.revision,archived:false})).status,409,'restore the parent first');
  const restoreParent=await post(categories,{action:'archive',id:guides.id,revision:guides.revision+1,archived:false});
  assert.equal(restoreParent.status,200);
  const restoreCategory=await post(categories,{action:'archive',id:setup.id,revision:archivedSetup.revision,archived:false});
  assert.equal(restoreCategory.status,200);
  const unarchiveArticle=await post(api,{action:'archive',id:articleId,revision:2,archived:false});
  assert.equal(unarchiveArticle.status,200);
  const page=await (await request('/?view=knowledge',{headers})).text();
  assert.match(page,/Manage categories/);
}
