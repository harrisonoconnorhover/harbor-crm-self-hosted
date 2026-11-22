import assert from 'node:assert/strict';
import {verifyTicketTags} from './portable-ticket-tags-fixture.mjs';
import {randomUUID} from 'node:crypto';

export async function verifyCustomerCasePortal({request,origin,headers,other,sql,center,unrelated}){
  const api='/api/case-portal',portal='/help/'+center.id+'/cases';
  async function post(url,data,actor=headers){
    const send=()=>request(url,{method:'POST',headers:{...actor,origin,'content-type':'application/json'},body:JSON.stringify(data)});
    const response=await send();
    if(response.status!==429)return response;
    const delay=Number(response.headers.get('retry-after'));
    assert.ok(delay>0&&delay<=60);
    await response.body?.cancel();
    await new Promise(resolve=>setTimeout(resolve,delay*1000));
    return send();
  }
  async function json(pending,status=200){
    const response=await pending;
    if(response.status!==status)assert.fail('Expected '+status+', got '+response.status+' at '+new URL(response.url).pathname+
      (response.status>=400?' '+(await response.text()):''));
    return response.json();
  }
  const createContact=async name=>(await json(post('/api/crm',{kind:'contacts',action:'save',
    data:{name,email:'accounts@example.test'}}),201)).record;
  const alice=await createContact('Fictional Alice'),bob=await createContact('Fictional Bob');
  assert.notEqual(alice.id,bob.id);
  const privateDescription='Internal triage notes about renewal pricing';
  const ticket=async(name,contact)=>(await json(post('/api/tickets',{action:'save',contactId:contact.id,
    data:{name,description:privateDescription}}),201)).record;
  let a=await ticket('Internal escalation for vendor review',alice);
  const b=await ticket('Internal billing investigation',bob);
  const unshared=await ticket('Keep this case internal',alice);
  const subjectA='Replacement battery request',updateA='Your replacement battery is being prepared.';
  const subjectB='Invoice explanation',updateB='A corrected statement is ready.';
  const state=(t,actor=headers)=>json(request(api+'?ticketId='+t.id,{headers:actor}));
  async function admin(action,t,extra={}){
    const s=await state(t);
    return json(post(api,{ticketId:t.id,contactId:t.contactId,ticketRevision:t.revision,
      expectedRevision:action==='invite'||action==='revoke'?s.access?.revision??0:s.publicationRevision,
      action,...extra}));
  }
  const exchange=(target,token)=>request(target,{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({action:'redeem',invite:token}).toString()});
  const root=(await json(request('/api/workspaces',{headers}))).owned;
  const granted=await json(post('/api/workspaces',{action:'grant',email:'other@example.test'}));
  const grant=granted.viewers.find(row=>row.email==='other@example.test');
  const viewerSave=await post('/api/tickets?'+new URLSearchParams({workspaceId:root,grantId:grant.id}),
    {action:'save',id:a.id,expectedRevision:a.revision,data:{name:a.data.name,tags:['viewer change']}},other);
  assert.equal(viewerSave.status,403);
  await json(post('/api/workspaces',{action:'role',id:grant.id,role:'editor'}));
  const previews=async()=>Array.from(await sql`SELECT kind,actor_email FROM portable_record_access_events WHERE workspace_id=${root}
    AND action='related' AND ((kind='contacts' AND record_ids=ARRAY[${alice.id}::uuid]) OR (kind='tickets' AND record_ids=ARRAY[${a.id}::uuid]))
    ORDER BY kind,actor_email`);
  const before=await previews();
  assert.equal((await request(api+'?ticketId='+a.id,{method:'HEAD',headers})).status,200);
  assert.equal((await request(api+'?ticketId='+a.id,{headers:other})).status,404);
  assert.deepEqual(await previews(),before);
  const ownerState=await state(a);
  const added=['contacts','tickets'].map(kind=>({kind,actor_email:'owner@example.test'}));
  assert.deepEqual(await previews(),[...before,...added].sort((a,b)=>a.kind.localeCompare(b.kind)));
  await json(post(api,{action:'withdraw',ticketId:a.id,contactId:alice.id,ticketRevision:a.revision,expectedRevision:0}));
  assert.deepEqual(await previews(),[...before,...added,...added].sort((a,b)=>a.kind.localeCompare(b.kind)));
  assert.equal(ownerState.center.id,center.id);
  assert.equal(ownerState.contact.id,alice.id);
  const foreignState=await request(api+'?ticketId='+a.id,{headers:other});
  assert.equal(foreignState.status,404);
  const blocked=await post(api+'?workspaceId='+root,{action:'invite',ticketId:a.id,ticketRevision:a.revision,
    contactId:alice.id,expectedRevision:0},other);
  assert.equal(blocked.status,403);
  assert.equal((await request(api+'?ticketId='+a.id)).status,401);

  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    a=await verifyTicketTags({browser,origin,request,headers,other,workspaceId:root,ticket:a});
    const staff=await browser.newContext(),customer=await browser.newContext({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await staff.addCookies([{name,value,url:origin}]);
    const owner=await staff.newPage(),page=await customer.newPage();
    owner.setDefaultTimeout(10000);page.setDefaultTimeout(10000);
    const guideId=randomUUID(),foreignGuide=randomUUID(),guideTitle='Battery return & packaging';
    const articleApi='/api/knowledge-base',publicationApi=articleApi+'?publication=1';
    const draftGuide=(id,title,revision,actor=headers)=>json(post(articleApi,{action:'save',id,revision,
      content:{title,subtitle:'',bodyHtml:'<p>Pack the battery in its return box.</p>',tags:[],category:''}},actor));
    const changeGuide=(id,action,revision,articleRevision,actor=headers)=>json(post(publicationApi,{action,id,revision,articleRevision},actor));
    await draftGuide(guideId,guideTitle,0);
    await draftGuide(foreignGuide,'Other workspace guide',0,other);
    await changeGuide(foreignGuide,'publish',0,1,other);
    for(const articleId of [guideId,foreignGuide]){
      const response=await post(api,{action:'publish',ticketId:a.id,ticketRevision:a.revision,expectedRevision:0,
        contactId:alice.id,subject:subjectA,update:updateA,articleId});
      assert.equal(response.status,409);
    }
    assert.equal((await state(a)).publication,null);
    await json(post(publicationApi,{action:'publish',id:guideId,revision:0,articleRevision:1,topic:'Battery returns'}));
    await draftGuide(guideId,'Unreleased packaging revision',1);
    await owner.goto(origin+'/tickets?id='+a.id);
    await owner.locator('summary').filter({hasText:/^Customer portal$/}).click();
    await owner.getByLabel('Customer-facing subject',{exact:true}).fill(subjectA);
    await owner.getByLabel('Customer update',{exact:true}).fill(updateA);
    await owner.getByText('Attach help article',{exact:true}).click();
    await owner.getByRole('button',{name:'Filter by topic'}).click();
    await owner.getByRole('button',{name:'More topics',exact:true}).click();
    const topic=owner.getByLabel('Published topic',{exact:true});
    await topic.locator('option').filter({hasText:'Kit '}).first().waitFor({state:'attached'});
    assert.equal(await topic.locator('option[value=""]').count(),1);
    assert.equal(await topic.getByText('Battery returns',{exact:true}).count(),0);
    await owner.getByRole('button',{name:'First topics',exact:true}).click();
    await topic.selectOption('Battery returns');
    await owner.getByRole('searchbox',{name:'Find a published article'}).fill('Battery return');
    await owner.getByRole('button',{name:'Attach '+guideTitle,exact:true}).click();
    assert.equal(await owner.getByLabel('Customer-facing subject',{exact:true}).inputValue(),subjectA);
    assert.equal(await owner.getByLabel('Customer update',{exact:true}).inputValue(),updateA);
    await owner.getByRole('button',{name:'Publish case',exact:true}).click();
    await owner.getByRole('button',{name:'Withdraw case',exact:true}).waitFor();
    await owner.getByRole('button',{name:'Create invitation',exact:true}).click();
    const link=owner.getByLabel('Customer invitation link',{exact:true});
    await link.waitFor();
    const invitation=new URL(await link.inputValue(),origin);
    assert.equal(invitation.origin,origin);
    assert.equal(invitation.pathname,portal);
    assert.equal(invitation.search,'');
    const invite=new URLSearchParams(invitation.hash.slice(1)).get('invite');
    assert.ok(invite&&invite.length>=32);
    // Link previews and GET prefetches cannot consume a customer's invitation.
    const landing=await request(portal);
    assert.equal(landing.status,200);
    assert.match(landing.headers.get('cache-control'),/no-store/);
    assert.doesNotMatch(await landing.text(),new RegExp(subjectA));
    await page.goto(invitation.href);
    await page.getByRole('button',{name:'Open my cases'}).click();
    const caseLink=page.getByRole('link',{name:subjectA,exact:true});
    await caseLink.waitFor();
    assert.equal(new URL(page.url()).hash,'');
    assert.ok(!((await page.locator('body').innerText()).includes(unshared.data.name)));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.getByRole('searchbox',{name:'Search case subjects'}).fill('BATTERY');
    await page.getByLabel('Status',{exact:true}).selectOption({label:'Waiting on you'});
    await page.getByRole('button',{name:'Apply filters'}).click();
    await page.getByText('No cases match these filters.').waitFor();
    await page.getByLabel('Status',{exact:true}).selectOption('New');
    await page.getByRole('button',{name:'Apply filters'}).click();
    await caseLink.waitFor();
    assert.equal(await page.getByRole('searchbox').inputValue(),'BATTERY');
    await page.getByRole('searchbox').fill('BEING PREPARED');
    await page.getByRole('button',{name:'Apply filters'}).click();
    await page.getByText('No cases match these filters.').waitFor();
    await page.getByRole('checkbox',{name:'Include published updates'}).check();
    await page.getByRole('button',{name:'Apply filters'}).click();
    await caseLink.click();
    await page.getByText(updateA,{exact:true}).waitFor();
    await page.getByRole('link',{name:'Back to case results'}).click();
    assert.equal(await page.getByRole('searchbox').inputValue(),'BEING PREPARED');
    assert.equal(await page.getByLabel('Status',{exact:true}).inputValue(),'New');
    assert.ok(await page.getByRole('checkbox',{name:'Include published updates'}).isChecked());
    await page.getByRole('link',{name:'Clear filters'}).click();
    const details=new URL(await caseLink.getAttribute('href'),origin);
    assert.equal(details.searchParams.get('case'),a.id);
    await caseLink.click();
    await page.getByRole('heading',{name:subjectA,exact:true}).waitFor();
    await page.getByText(updateA,{exact:true}).waitFor();
    const guide=page.getByRole('link',{name:guideTitle,exact:true});
    assert.equal(await guide.getAttribute('href'),'/help/'+center.id+'/'+guideId);
    await guide.click();
    await page.getByRole('heading',{name:guideTitle,exact:true}).waitFor();
    await page.goBack();
    await page.getByRole('heading',{name:subjectA,exact:true}).waitFor();
    assert.ok(!(await page.content()).includes('Unreleased packaging revision'));
    await changeGuide(guideId,'withdraw',1,2);
    await page.reload();
    assert.equal(await page.getByRole('heading',{name:'Related help article'}).count(),0);
    await changeGuide(guideId,'publish',2,2);
    await page.reload();
    const currentGuide=page.getByRole('link',{name:'Unreleased packaging revision',exact:true});
    await currentGuide.waitFor();
    const privateBody=await page.content();
    for(const secret of ['internal escalation',privateDescription,a.data.name,b.data.name,unshared.data.name])assert.ok(!privateBody.includes(secret),secret);
    const revision=(await state(a)).publicationRevision;
    const progress='Your replacement has shipped.';
    await admin('publish',a,{subject:subjectA,update:progress});
    assert.equal((await post(api,{action:'withdraw',ticketId:a.id,ticketRevision:a.revision,contactId:alice.id,expectedRevision:revision})).status,409);
    await page.reload();
    await page.getByText(progress,{exact:true}).waitFor();
    await currentGuide.waitFor(); // Older clients can update the text without removing the article.
    await owner.reload();
    await owner.locator('summary').filter({hasText:/^Customer portal$/}).click();
    await owner.getByRole('button',{name:'Remove article',exact:true}).click();
    await owner.getByRole('button',{name:'Save published case',exact:true}).click();
    await owner.getByText('Case published.',{exact:true}).waitFor();
    await page.reload();
    assert.equal(await currentGuide.count(),0);

    await admin('withdraw',a);
    assert.equal((await page.reload()).status(),404);
    await admin('publish',a,{subject:subjectA,update:updateA});
    await page.reload();
    await page.getByText(updateA,{exact:true}).waitFor();
    const cookie=(await customer.cookies(origin+portal)).find(c=>c.httpOnly);
    assert.ok(cookie,'Customer access uses its own HttpOnly cookie');
    const customerHeaders={cookie:cookie.name+'='+cookie.value};
    const read=(url,auth=customerHeaders)=>request(url,{headers:auth});
    assert.equal((await read('/api/tickets?id='+a.id)).status,401);
    assert.ok((await exchange(portal,invite)).status>=400,'Invitation only works once');
    assert.equal((await read('/help/'+unrelated.id+'/cases?case='+a.id)).status,404);
    assert.equal((await read(portal+'?case='+unshared.id)).status,404);

    await admin('publish',b,{subject:subjectB,update:updateB});
    assert.equal((await read(portal+'?case='+b.id)).status,404);
    const list=await (await read(portal)).text();
    assert.ok(list.includes(subjectA)&&!list.includes(subjectB));
    for(const q of [subjectB,updateB,privateDescription,a.data.name,progress]){
      const filtered=await read(portal+'?'+new URLSearchParams({q,updates:'1'}));
      assert.equal(filtered.status,200);
      assert.match(await filtered.text(),/No cases match these filters/);
    }
    const {inviteToken}=await admin('invite',b);
    assert.ok((await exchange('/help/'+unrelated.id+'/cases',inviteToken)).status>=400);
    const simultaneous=await Promise.all([exchange(portal,inviteToken),exchange(portal,inviteToken)]);
    assert.deepEqual(simultaneous.map(r=>r.status).sort(),[303,403]);
    const redeemed=simultaneous.find(r=>r.status===303);
    const bobHeaders={cookie:redeemed.headers.get('set-cookie').split(';')[0]};
    assert.equal((await read(details.pathname+details.search,bobHeaders)).status,404);
    assert.ok((await (await read(portal+'?case='+b.id,bobHeaders)).text()).includes(updateB));
    const waiting=await json(post('/api/tickets',{id:a.id,action:'status',expectedRevision:a.revision,status:'Waiting on contact'}));
    await page.goto(origin+portal);
    await page.getByLabel('Status',{exact:true}).selectOption({label:'Waiting on you'});
    await page.getByRole('button',{name:'Apply filters'}).click();
    await page.getByRole('link',{name:subjectA,exact:true}).click();
    await page.getByText('Status · Waiting on you').waitFor();
    const changed=await json(post('/api/tickets',{id:a.id,action:'status',expectedRevision:waiting.record.revision,status:'Closed'}));
    assert.equal(changed.record.data.ticketStatus,'Closed');
    await page.reload();
    await page.getByText(/Status · Closed/).waitFor();

    // Reassigning a ticket cannot transfer a published update to another customer,
    // or bring it back if staff later reconnect the original contact.
    const reassign=async(t,contact)=>(await json(post('/api/tickets',{action:'save',id:t.id,expectedRevision:t.revision,
      contactId:contact.id,data:{name:t.data.name}}))).record;
    await admin('publish',b,{subject:subjectB,update:updateB,articleId:guideId});
    const reassigned=await reassign(b,alice);
    const [withdrawn]=await sql`SELECT article_id FROM portable_case_publications WHERE workspace_id=${root} AND ticket_id=${b.id}`;
    assert.equal(withdrawn.article_id,null);
    for(const auth of [bobHeaders,customerHeaders])assert.equal((await read(portal+'?case='+b.id,auth)).status,404);
    const returned=await reassign(reassigned,bob);
    assert.equal((await read(portal+'?case='+b.id,bobHeaders)).status,404);
    await admin('publish',returned,{subject:subjectB,update:updateB});
    const archive=async(action,expectedRevision)=>(await json(post('/api/recycle-bin',{action,kind:'tickets',
      id:b.id,expectedRevision,requestId:randomUUID()}))).receipt;
    const archived=await archive('archive',returned.revision);
    assert.equal((await read(portal+'?case='+b.id,bobHeaders)).status,404);
    await archive('restore',archived.revision);
    assert.equal((await read(portal+'?case='+b.id,bobHeaders)).status,404);

    await owner.reload();
    await owner.locator('summary').filter({hasText:/^Customer portal$/}).click();
    await owner.getByRole('button',{name:'Revoke customer access',exact:true}).click();
    await owner.getByRole('button',{name:'Create invitation',exact:true}).waitFor();
    const revoked=await page.reload();
    assert.equal(revoked.status(),404);
    assert.ok(!(await page.content()).includes(updateA));
    assert.ok(!(await (await read(portal)).text()).includes(subjectA));
    const extraTickets=await sql`INSERT INTO portable_tickets (workspace_id,id,data,contact_id,revision,created_at,updated_at,closed_at)
      SELECT ${root},gen_random_uuid(),jsonb_build_object('name','Internal logistics '||n,'ticketStatus',CASE WHEN n=27 THEN 'Closed' ELSE 'New' END),
        ${bob.id},1,now(),now(),CASE WHEN n=27 THEN now() END FROM generate_series(1,28) n RETURNING id`;
    await sql`INSERT INTO portable_case_publications (workspace_id,ticket_id,contact_id,revision,subject,customer_update)
      SELECT ${root},id,${bob.id},1,(CASE WHEN data->>'name'='Internal logistics 28' THEN 'Order 300X' ELSE 'Order 30%_' END)||id::text,
        CASE WHEN data->>'name'='Internal logistics 28' THEN 'Shipping update PKG300X' ELSE 'Shipping update PKG30%_' END
      FROM portable_tickets WHERE workspace_id=${root} AND id IN ${sql(extraTickets.map(row=>row.id))}`;
    const first=await (await read(portal,bobHeaders)).text(),next=first.match(/href="([^"]+)">More cases/);
    assert.ok(next,'More cases is available for Bob after Alice is revoked');
    const second=await (await read(next[1],bobHeaders)).text();
    const caseIds=html=>[...html.matchAll(/href="[^"]+\?case=([0-9a-f-]+)(?:&amp;[^"]*)?"/g)].map(match=>match[1]);
    assert.equal(caseIds(first).length,25);
    assert.equal(caseIds(second).length,3);
    assert.equal(new Set([...caseIds(first),...caseIds(second)]).size,28);
    for(const search of [{q:'oRdeR 30%_',status:'New'},{q:'pkg30%_',status:'New',updates:'1'}]){
      const filteredPath=portal+'?'+new URLSearchParams(search);
      const filteredFirst=await (await read(filteredPath,bobHeaders)).text();
      const more=/href="([^"]+)">More cases/.exec(filteredFirst)?.[1].replaceAll('&amp;','&');
      assert.ok(more);
      const filteredSecond=await (await read(more,bobHeaders)).text();
      assert.equal(new Set([...caseIds(filteredFirst),...caseIds(filteredSecond)]).size,26);
      assert.equal(caseIds(filteredSecond).length,1);
      const detailLink=filteredSecond.match(/href="([^"]+\?case=[^"]+)"/)[1].replaceAll('&amp;','&');
      const detailBody=await (await read(detailLink,bobHeaders)).text();
      const returnLink=detailBody.match(/href="([^"]+)">Back to case results/)[1].replaceAll('&amp;','&');
      assert.equal(returnLink,more);
      assert.deepEqual(caseIds(await (await read(returnLink,bobHeaders)).text()),caseIds(filteredSecond));
      assert.ok(!filteredSecond.includes('Shipping update'),'List pages return subjects and status only');
      const firstLink=/href="([^"]+)">First page/.exec(filteredSecond)?.[1].replaceAll('&amp;','&');
      assert.equal(firstLink,filteredPath);
      assert.deepEqual(caseIds(await (await read(firstLink,bobHeaders)).text()),caseIds(filteredFirst));
    }

    const sample=portal+'?case='+extraTickets[0].id;
    const refreshed=await state(b);
    const current={...b,revision:refreshed.ticketRevision};
    const replacement=await admin('invite',current);
    assert.equal((await read(sample,bobHeaders)).status,404);
    const signedIn=await exchange(portal,replacement.inviteToken);
    assert.equal(signedIn.status,303);
    const freshHeaders={cookie:signedIn.headers.get('set-cookie').split(';')[0]};
    assert.ok((await (await read(sample,freshHeaders)).text()).includes('Shipping update'));
    const signedOut=await request(portal,{method:'POST',headers:{...freshHeaders,origin,'content-type':'application/x-www-form-urlencoded'},body:'action=signout'});
    assert.equal(signedOut.status,303);
    assert.equal((await read(sample,freshHeaders)).status,404);

    const toExpire=await admin('invite',current);
    const expire=()=>sql`UPDATE portable_case_access SET expires_at=1 WHERE workspace_id=${root} AND contact_id=${bob.id}`;
    await expire();
    assert.equal((await exchange(portal,toExpire.inviteToken)).status,403);
    const nextAccess=await admin('invite',current);
    const last=await exchange(portal,nextAccess.inviteToken);
    assert.equal(last.status,303);
    const lastHeaders={cookie:last.headers.get('set-cookie').split(';')[0]};
    await expire();
    assert.equal((await read(sample,lastHeaders)).status,404);
    const forClosure=await admin('invite',current);
    const final=await exchange(portal,forClosure.inviteToken);
    assert.equal(final.status,303);
    const finalHeaders={cookie:final.headers.get('set-cookie').split(';')[0]},help='/api/knowledge-base?publication=1';
    const centerSettings=(await json(request(help,{headers}))).center;
    const toggle=(enabled,revision)=>json(post(help,{action:'settings',revision,enabled,name:centerSettings.name,accent:centerSettings.accent}));
    const closed=await toggle(false,centerSettings.revision);
    assert.equal((await read(portal,finalHeaders)).status,404);
    await toggle(true,closed.center.revision);
    assert.equal((await read(sample,finalHeaders)).status,404);

    // A restored CRM Contact keeps its staff records but requires new portal access and publication.
    const renamed=await json(post('/api/crm',{kind:'contacts',action:'save',id:bob.id,expectedRevision:bob.revision,
      data:{name:bob.data.name,email:'bob@example.test'}}));
    const portalAgain=await admin('invite',current);
    const prior=await exchange(portal,portalAgain.inviteToken);
    assert.equal(prior.status,303);
    const priorHeaders={cookie:prior.headers.get('set-cookie').split(';')[0]};
    assert.equal((await read(sample,priorHeaders)).status,200);
    const archiveContact=async(action,revision)=>(await json(post('/api/recycle-bin',{action,kind:'contacts',
      id:bob.id,expectedRevision:revision,requestId:randomUUID()}))).receipt;
    const removed=await archiveContact('archive',renamed.record.revision);
    assert.equal((await read(sample,priorHeaders)).status,404);
    await archiveContact('restore',removed.revision);
    assert.equal((await read(sample,priorHeaders)).status,404);
    const newInvite=await admin('invite',current);
    const back=await exchange(portal,newInvite.inviteToken);
    assert.equal(back.status,303);
    assert.equal((await read(sample,{cookie:back.headers.get('set-cookie').split(';')[0]})).status,404);
  }finally{
    await browser.close();
  }
}
