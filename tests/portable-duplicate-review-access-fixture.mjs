import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyDuplicateReviewAccess({get,send,ok,sql,workspaceId,other,origin}){
  const companyName='Fictional Amber Harbor';
  async function company(){
    const result=await (await ok(send('/api/crm',{action:'save',kind:'companies',data:{name:companyName}}))).json();
    return result.record.id;
  }
  const companies=[await company(),await company()];
  const contactName='Fictional Amber contact';
  // A public record ID can identify a contact and a company in the same workspace.
  const contacts=[...companies,...Array.from({length:10},()=>randomUUID())];
  await sql`INSERT INTO contacts (workspace_id,id,revision,primary_company_id,data,created_at,updated_at)
    SELECT ${workspaceId},id,3,${companies[0]},jsonb_build_object('name',${contactName}::text),now(),now()
      FROM unnest(${contacts}::uuid[]) id`;

  const events=()=>sql`SELECT id,actor_email,action,kind,record_ids FROM portable_record_access_events WHERE workspace_id=${workspaceId}`;
  async function check(run,expected,status=200){
    const before=new Set((await events()).map(row=>row.id));
    const response=await run();
    assert.equal(response.status,status,await response.clone().text());
    const body=await response.text();
    const result=body?JSON.parse(body):null;
    const receipts=(await events()).filter(row=>!before.has(row.id))
      .map(row=>[row.actor_email,row.action,row.kind,...row.record_ids]);
    assert.deepEqual(receipts.sort(),expected(result).sort());
    return result;
  }
  const rep='other@example.test',owner='owner@example.test';
  const member=sharing=>sharing.viewers.find(person=>person.email===rep).id;
  const newlyGranted=await (await ok(send('/api/workspaces',{action:'grant',email:rep}))).json();
  const editor=await (await ok(send('/api/workspaces',{action:'role',id:member(newlyGranted),role:'editor'}))).json();
  const scope=new URLSearchParams({workspaceId,grantId:member(editor)});
  const path='/api/duplicates?kind=contacts&query='+encodeURIComponent(contactName)+'&'+scope;
  const checkPage=result=>{
    const records=result.pairs.flatMap(pair=>[pair.left,pair.right]);
    for(const record of records){
      assert.equal(record.name,contactName);
      assert.equal(record.revision,3);
      assert.equal(record.companyId,companies[0]);
      assert.equal(record.company,companyName);
    }
    return [[rep,'duplicates','contacts',...new Set(records.map(record=>record.id))],[rep,'related','companies',companies[0]]];
  };
  await check(()=>get(path,other,'HEAD'),()=>[]);
  const first=await check(()=>get(path,other),checkPage);
  assert.equal(first.total,66);
  assert.equal(first.pairs.length,50);
  const last=await check(()=>get(path+'&cursor='+encodeURIComponent(first.nextCursor),other),checkPage);
  assert.equal(last.pairs.length,16);
  assert.equal(last.nextCursor,null);
  const [primaryId,secondaryId]=contacts;
  await ok(send('/api/duplicates?'+scope,{action:'dismiss',kind:'contacts',recordA:primaryId,recordB:secondaryId},other));
  const dismissed=await check(()=>get(path+'&status=dismissed',other),checkPage);
  assert.equal(dismissed.pairs.length,1);
  await check(()=>get('/api/duplicates?kind=companies&query='+encodeURIComponent(companyName)),result=>
    [[owner,'duplicates','companies',result.pairs[0].left.id,result.pairs[0].right.id]]);
  const preview=(kind,ids)=>send('/api/record-merge',{action:'preview',kind,primaryId:ids[0],secondaryId:ids[1]});
  await check(()=>preview('contacts',contacts),()=>[[owner,'merge_preview','contacts',primaryId,secondaryId],[owner,'related','companies',companies[0]]]);
  await check(()=>preview('companies',companies),()=>[[owner,'merge_preview','companies',...companies]]);
  await check(()=>preview('contacts',[primaryId,randomUUID()]),()=>[],404);
  await check(()=>get('/api/duplicates?query=absent-amber-example'),()=>[]);
  await verifyScopedDecisions({send,get,ok,sql,workspaceId,other,origin,grantId:member(editor),contacts,companies,contactName,companyName});
  await check(()=>get(path,other),()=>[],403);
  const history=await (await ok(get('/?view=record-access&action=merge_preview&record='+primaryId+'&kind=contacts'))).text();
  assert.ok(history.includes(primaryId)&&history.includes(owner));
}

async function verifyScopedDecisions({send,get,ok,sql,workspaceId,other,origin,grantId,contacts,companies,contactName,companyName}){
  // Earlier audit scenarios use the same two sessions within one rate-limit window.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
    AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const manage=async body=>(await ok(send('/api/workspaces',body))).json();
  const [rep]=await sql`SELECT id,email FROM login_identities WHERE email='other@example.test'`;
  async function assign(kind,ids,person){
    await sql`UPDATE ${sql(kind)} SET data=jsonb_set(data,'{recordOwner}',jsonb_build_object(
      'workspaceId',workspace_id::text,'userId',${person.id}::text,'label',${person.email}::text))
      WHERE workspace_id=${workspaceId} AND id=ANY(${ids}::uuid[])`;
  }
  await assign('contacts',contacts.slice(0,2),rep);
  // Both kinds have the same pair of IDs. Decisions belong to their own record type.
  const decision=(kind,action,ids)=>({kind,action,recordA:ids[0],recordB:ids[1]});
  await ok(send('/api/duplicates',decision('companies','dismiss',companies)));
  const narrow=async(viewScope,editScope)=>{
    const access=await manage({action:'record_scope',id:grantId,viewScope,editScope});
    grantId=access.viewers.find(row=>row.email===rep.email).id;
  };
  const scope=()=>new URLSearchParams({workspaceId,grantId}).toString();
  const queue=async(kind,status='suggested')=>(await ok(get('/api/duplicates?'+scope()+'&'+new URLSearchParams({
    kind,status,query:kind==='contacts'?contactName:companyName}),other))).json();
  const change=(kind,action,ids)=>send('/api/duplicates?'+scope(),decision(kind,action,ids),other);
  await narrow('owned','owned');
  const dismissed=await queue('contacts','dismissed');
  assert.equal(dismissed.total,1);
  assert.equal(dismissed.pairs[0].left.company,undefined);
  assert.equal(dismissed.pairs[0].right.companyId,undefined);
  assert.deepEqual(dismissed.pairs[0].reasons,['Same full name']);
  await ok(change('contacts','restore',contacts));
  assert.equal((await queue('contacts')).total,1);
  assert.equal((await queue('companies','dismissed')).total,0);
  assert.equal((await change('contacts','dismiss',[contacts[0],contacts[2]])).status,404);
  assert.equal((await change('companies','restore',companies)).status,404);
  const persisted=await (await ok(get('/api/duplicates?kind=companies&status=dismissed&query='+encodeURIComponent(companyName)))).json();
  assert.equal(persisted.total,1);
  await narrow('all','owned');
  const expanded=await queue('contacts');
  assert.equal(expanded.total,1);
  assert.equal(expanded.pairs[0].left.company,companyName);
  assert.equal((await send('/api/record-merge?'+scope(),{action:'preview',kind:'contacts',primaryId:contacts[0],secondaryId:contacts[1]},other)).status,403);
  const parent=randomUUID(),child=randomUUID();
  await manage({action:'team_create',id:parent,name:'Fictional duplicate reviewers',parentId:null});
  await manage({action:'team_create',id:child,name:'Fictional renewals reviewers',parentId:parent});
  await manage({action:'team_assign',id:grantId,teamId:parent,previousTeamId:null});
  const colleague={id:randomUUID(),email:'amber-rep@example.test'};
  await sql`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
    VALUES (${colleague.id},${colleague.id},${colleague.email},${Date.now()},${Date.now()})`;
  await sql`INSERT INTO portable_workspace_viewers(workspace_id,id,viewer_id,team_id,role)
    VALUES (${workspaceId},gen_random_uuid(),${colleague.id},${child},'editor')`;
  await assign('contacts',[contacts[2]],colleague);
  await assign('companies',companies,colleague);
  await narrow('team','team');
  assert.equal((await queue('contacts')).total,3);
  assert.equal((await queue('companies','dismissed')).total,1);
  await ok(change('companies','restore',companies));
  assert.equal((await queue('companies')).total,1);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage();
    const [name,value]=other.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=duplicates&workspaceId='+workspaceId);
    const search=page.getByRole('search');
    await search.getByLabel('Search',{exact:true}).fill(contactName);
    await search.getByRole('button',{name:'Search',exact:true}).click();
    const pair=page.locator('.portable-duplicate-pairs li').first();
    const record=pair.getByRole('link',{name:contactName,exact:true}).first();
    await record.waitFor();
    assert.equal(new URL(await record.getAttribute('href'),origin).searchParams.get('workspaceId'),workspaceId);
    assert.equal(await page.getByRole('button',{name:'Review merge'}).count(),0);
    await pair.getByRole('button',{name:'Not duplicates'}).click();
    await page.getByText('Dismissed. Find it under Dismissed.').waitFor();
    const dismissedAfterClick=await queue('contacts','dismissed');
    assert.equal(dismissedAfterClick.total,1);
    let release;
    const delayed=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/duplicates?**',async route=>{
      if(new URL(route.request().url()).searchParams.get('status')==='dismissed')await delayed;
      await route.continue();
    });
    try{
      await search.getByLabel('Show').selectOption('dismissed');
      assert.equal(await page.getByRole('button',{name:'Restore suggestion'}).count(),0);
    }finally{release();}
    const restore=page.getByRole('button',{name:'Restore suggestion'});
    await restore.waitFor();
    const [owner]=await sql`SELECT id,email FROM login_identities WHERE email='owner@example.test'`;
    await assign('contacts',[dismissedAfterClick.pairs[0].left.id],owner);
    const rejected=page.waitForResponse(response=>response.url().includes('/api/duplicates')&&response.request().method()==='POST');
    await restore.click();
    assert.equal((await rejected).status(),404);
    await page.getByText(/0 dismissed pairs/).waitFor();
    await manage({action:'revoke',id:grantId});
    await search.getByLabel('Show').selectOption('suggested');
    await page.getByRole('alert').waitFor();
    assert.equal(await page.locator('.portable-duplicate-pairs li').count(),0);
  }finally{await browser.close();}
}
