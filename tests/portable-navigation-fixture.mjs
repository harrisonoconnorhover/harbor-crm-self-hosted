import assert from 'node:assert/strict';
import {verifyPortableSettingsNavigation} from './portable-settings-navigation-fixture.mjs';
import {verifyCallsNavigation} from './portable-calls-navigation-fixture.mjs';
import {verifySalesWorkspace} from './portable-sales-workspace-fixture.mjs';

const categories=['Bookmarks','CRM','Marketing','Content','Sales','Revenue','Service','Data management','Automations','Reporting'];

export async function verifyNavigation({request,origin,headers,other,sql,signIn,configure}){
  const post=(path,body,identity=headers)=>request(path,{method:'POST',headers:{...identity,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const write=async(path,body)=>{
    const result=await post(path,body);
    assert.ok(result.ok,await result.clone().text());
    return result.json();
  };
  const {record:contact}=await write('/api/crm',{action:'save',kind:'contacts',data:{name:'Navigation trial'}});
  const sharing=await write('/api/workspaces',{action:'grant',email:'other@example.test'});
  const workspaceId=sharing.owned;
  const grant=sharing.viewers.find(item=>item.email==='other@example.test').id;
  const bookmarks='/api/navigation-bookmarks';
  const read=async identity=>(await (await request(bookmarks,{headers:identity})).json()).items;
  await verifyPortableSettingsNavigation({request,headers,other,workspaceId});
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  async function checkMenuRoutes(nav,identity,scope){
    const paths=await nav.locator('.portable-nav-panel li a').evaluateAll(links=>[...new Set(links.map(link=>link.getAttribute('href')))]);
    for(const path of paths){
      const url=new URL(path,origin);
      if(scope)assert.equal(url.searchParams.get('workspaceId'),scope,path);
      assert.equal((await request(url.pathname+url.search,{headers:identity})).status,200,path);
    }
  }
  async function session(identity,viewport){
    const context=await browser.newContext({viewport});
    const [name,value]=identity.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    return context.newPage();
  }
  try{
    const fresh=await browser.newPage();
    const emailSettings='/?view=email-settings';
    const bookmarksThroughLogin=[
      ...['email-templates','email-connection','outlook-connection','email-suppressions','email-never-log','email-opt-out'].map(id=>emailSettings+'#'+id),
      '/?view=workflows&runIssue=queue_full#recent-runs','/?view=getting-started#guide-import',
      '/?view=dashboards&dashboardId='+crypto.randomUUID()+'&workspaceId='+workspaceId+'#report-'+crypto.randomUUID(),
      '/?contact='+contact.id+'#portable-contact-files','/?view=forms&formId='+crypto.randomUUID()+'#form-inquiries',
    ];
    for(const path of bookmarksThroughLogin){
      await fresh.goto(origin+path);
      await fresh.waitForFunction(path=>{
        const links=[...document.querySelectorAll('.welcome-google')];
        return links.length>0&&links.every(link=>new URL(link.href).searchParams.get('return_to')===path);
      },path);
    }
    await fresh.goto(origin+emailSettings+'#invite-teammate');
    assert.equal(new URL(await fresh.getByRole('link',{name:'Continue with Google'}).getAttribute('href'),origin).searchParams.get('return_to'),emailSettings);
    for(const section of ['invite-teammate','team-directory']){
      await fresh.context().clearCookies();
      await fresh.goto('about:blank');
      const bookmark='/?view=workspaces#'+section;
      await fresh.goto(origin+bookmark);
      await fresh.waitForFunction(path=>{
        const link=document.querySelector('a[href^="/auth/google/start"]');
        return link&&new URL(link.href).searchParams.get('return_to')===path;
      },bookmark,{timeout:5000});
      const start=new URL(await fresh.getByRole('link',{name:'Continue with Google'}).getAttribute('href'),origin);
      const destination=start.searchParams.get('return_to');
      const signed=await signIn('owner@example.test',request,origin,destination);
      const [cookieName,cookieValue]=signed.cookie.split('=');
      await fresh.context().addCookies([{name:cookieName,value:cookieValue,url:origin}]);
      await fresh.goto(origin+destination);
      if(section==='team-directory')await fresh.waitForFunction(()=>document.activeElement?.id==='team-directory');
      else await fresh.locator('#invite-teammate[open]').getByRole('textbox',{name:'Teammate email',exact:true}).waitFor();
    }
    const invoiceBookmark='/?view=invoices&q=North+%26+South&status=open&dueFrom=2026-11-01';
    const invoiceLogin=await request(invoiceBookmark);
    const invoiceReturn=new URL(invoiceLogin.headers.get('location'),origin).searchParams.get('return_to');
    await fresh.goto(origin+invoiceReturn);
    assert.equal(await fresh.getByLabel('Search title, buyer or reference').inputValue(),'North & South');
    assert.equal(await fresh.getByRole('combobox',{name:/^Status/}).inputValue(),'open');
    assert.equal(await fresh.getByLabel('Due date from').inputValue(),'2026-11-01');
    const workflowBookmark='/?view=workflows&runIssue=queue_full#recent-runs';
    await signIn('owner@example.test',request,origin,workflowBookmark);
    await fresh.goto(origin+workflowBookmark);
    await fresh.getByRole('heading',{name:'Recent runs',exact:true}).waitFor();
    await fresh.close();
    const owner=await session(headers,{width:1440,height:900});
    await owner.goto(origin);
    const nav=owner.getByRole('navigation',{name:'Main navigation'});
    assert.deepEqual(await nav.locator('.portable-nav-category').allTextContents(),categories);
    // Destinations shared by two sections must take the user to the same place.
    for(const [label,first,second,path] of [
      ['Tickets','CRM','Service','/tickets'],['Inbox','CRM','Service','/?view=team-inbox'],
      ['Quotes','CRM','Revenue','/quotes'],['Landing pages','Marketing','Content','/?view=landing-pages'],
    ]){
      for(const section of [first,second]){
        const panel=nav.locator('[aria-label="'+section+' tools"]');
        assert.equal(await panel.getByRole('link',{name:label,exact:true,includeHidden:true}).getAttribute('href'),path);
      }
    }
    await nav.getByRole('button',{name:'Data management',exact:true}).click();
    await nav.getByRole('link',{name:'Data management settings',exact:true}).click();
    assert.equal(await nav.locator('[data-current]').textContent(),'Data management');
    await owner.getByRole('navigation',{name:'Settings navigation'}).getByRole('link',{name:'API access',exact:true}).click();
    assert.equal(new URL(owner.url()).searchParams.get('view'),'api-access');
    const marketingPanel=nav.locator('[aria-label="Marketing tools"]');
    assert.equal(await marketingPanel.getByRole('link',{name:'Campaigns',exact:true,includeHidden:true}).count(),0);
    await nav.getByRole('button',{name:'Marketing',exact:true}).click();
    await marketingPanel.getByRole('link',{name:'Marketing analytics',exact:true}).click();
    assert.equal(new URL(owner.url()).searchParams.get('view'),'web-attribution');
    await owner.getByRole('heading',{level:1,name:'Marketing analytics',exact:true}).waitFor();
    assert.equal(await nav.locator('[data-current]').textContent(),'Marketing');
    await nav.getByRole('button',{name:'Reporting',exact:true}).click();
    await nav.getByRole('link',{name:'Reports',exact:true}).click();
    await owner.getByRole('link',{name:'Marketing analytics',exact:true}).click();
    const analytics=owner.getByRole('navigation',{name:'Marketing analytics',exact:true});
    await analytics.getByRole('link',{name:'Web attribution',exact:true}).click();
    assert.equal(new URL(owner.url()).searchParams.get('view'),'web-attribution');
    assert.equal(new URL(owner.url()).searchParams.get('tab'),'report');
    assert.equal(await analytics.getByRole('link',{name:'Web attribution',exact:true}).getAttribute('aria-current'),'page');
    await configure({HARBOR_MARKETING_WORKSPACE_ID:workspaceId});
    await owner.reload();
    for(const [tool,view] of [['Email marketing','marketing'],['Campaigns','campaigns']]){
      await nav.getByRole('button',{name:'Marketing',exact:true}).click();
      await marketingPanel.getByRole('link',{name:tool,exact:true}).click();
      assert.equal(new URL(owner.url()).searchParams.get('view'),view);
      await owner.getByRole('heading',{level:1,name:tool,exact:true}).waitFor();
      await owner.getByRole('link',{name:'Marketing analytics',exact:true}).click();
      await owner.getByRole('heading',{level:1,name:'Marketing analytics',exact:true}).waitFor();
    }
    await checkMenuRoutes(nav,headers);
    await nav.getByRole('button',{name:'Service',exact:true}).click();
    await nav.getByRole('link',{name:'Help desk',exact:true}).click();
    await owner.getByRole('heading',{name:'Help desk',level:1}).waitFor();
    await owner.getByRole('link',{name:'My first responses',exact:true}).click();
    assert.equal(new URL(owner.url()).searchParams.get('assignee'),'me');
    await nav.getByRole('button',{name:'Service',exact:true}).click();
    await nav.getByRole('link',{name:'Customer portal',exact:true}).click();
    await owner.getByRole('heading',{name:'Portal closed',exact:true}).waitFor();
    assert.equal(await owner.getByRole('link',{name:'Open customer sign-in'}).count(),0);
    assert.equal(await owner.getByRole('link',{name:'Open tickets'}).getAttribute('href'),'/tickets');
    assert.equal(await owner.getByRole('link',{name:'Manage help center'}).getAttribute('href'),'/?view=knowledge');
    const settings='/api/knowledge-base?publication=1';
    const {center}=await write(settings,{action:'settings',enabled:true,name:'Navigation trial help',accent:'#17696b',revision:0});
    await owner.reload();
    await owner.getByRole('link',{name:'Open customer sign-in'}).click();
    assert.equal(new URL(owner.url()).pathname,'/help/'+center.id+'/cases');
    await owner.getByRole('heading',{name:'My cases'}).waitFor();
    await write(settings,{action:'settings',enabled:false,name:center.name,accent:center.accent,revision:center.revision});
    await owner.goBack();
    await owner.reload();
    await owner.getByRole('heading',{name:'Portal closed',exact:true}).waitFor();
    assert.equal((await request('/?view=customer-portal&workspaceId='+workspaceId,{headers:other})).status,404);
    await verifyCallsNavigation({owner,nav,request,post,sql,other,workspaceId,grant});
    await nav.getByRole('button',{name:'Data management',exact:true}).click();
    await nav.getByRole('link',{name:'Integrations',exact:true}).click();
    await owner.getByRole('heading',{name:'Integrations',level:1}).waitFor();
    assert.equal(await owner.getByRole('navigation',{name:'Settings navigation'}).getByRole('link',{name:'Integrations',exact:true}).getAttribute('aria-current'),'page');
    const connections=owner.locator('.portable-settings-pane');
    await connections.getByRole('heading',{name:'Email and calendar'}).waitFor();
    for(const href of await connections.getByRole('link').evaluateAll(links=>links.map(link=>link.getAttribute('href')))){
      const url=new URL(href,origin);
      const response=await request(url.pathname+url.search,{headers});
      assert.equal(response.status,200,href);
      if(url.hash)assert.ok((await response.text()).includes('id="'+url.hash.slice(1)+'"'),href);
    }
    const rect=await nav.boundingBox();
    assert.ok(rect.x===0&&rect.width<300&&rect.height>650);
    await nav.getByRole('button',{name:'CRM',exact:true}).click();
    for(const name of ['Contacts','Deals','Lists','Inbox','Snippets','Email templates']){
      assert.ok(await nav.getByRole('link',{name,exact:true}).isVisible(),name);
    }
    await nav.getByRole('button',{name:'Pin Contacts',exact:true}).click();
    await nav.getByRole('button',{name:'Unpin Contacts',exact:true}).waitFor();
    await nav.getByRole('button',{name:'Bookmarks',exact:true}).click();
    assert.ok(await nav.getByRole('link',{name:'Contacts',exact:true}).isVisible());
    await owner.keyboard.press('Escape');
    assert.ok(await nav.getByRole('button',{name:'Bookmarks',exact:true}).evaluate(el=>el===document.activeElement));
    const pins=['companies','deals','tickets','tasks','reports','workflows'];
    const responses=await Promise.all(pins.map(tool=>post(bookmarks,{tool,pin:true})));
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,200,200,200,409,409]);
    const saved=await read(headers);
    assert.equal(new Set(saved).size,5);
    assert.equal((await post(bookmarks,{tool:'contacts',pin:true})).status,200);
    assert.deepEqual(await read(other),[]);
    await owner.reload();
    await nav.getByRole('button',{name:'Bookmarks',exact:true}).click();
    await nav.getByRole('link',{name:'Contacts',exact:true}).waitFor();
    assert.equal(await nav.getByRole('link').count(),5);
    await nav.getByRole('button',{name:'Unpin Contacts',exact:true}).click();
    await nav.getByRole('link',{name:'Contacts',exact:true}).waitFor({state:'hidden'});
    assert.equal((await read(headers)).length,4);
    await owner.getByText('Find in Harbor',{exact:true}).click();
    const ownerField=owner.getByRole('searchbox',{name:'Search CRM records'});
    const matchingTools=owner.getByRole('region',{name:'Matching tools'});
    await ownerField.fill('CRM');
    await matchingTools.getByRole('button',{name:/Show all .* tools/}).click();
    await matchingTools.getByRole('link',{name:'Email templates',exact:true}).waitFor();
    await ownerField.fill('pipeline');
    await ownerField.fill('CRM');
    await matchingTools.getByRole('button',{name:/Show all .* tools/}).waitFor();
    assert.equal(await matchingTools.getByRole('link').count(),6);
    await ownerField.fill('pipeline');
    await owner.getByRole('link',{name:'Pipeline settings',exact:true}).click();
    await owner.getByRole('navigation',{name:'Settings navigation'}).waitFor();
    assert.equal(new URL(owner.url()).searchParams.get('section'),'pipelines');
    // Returning from a tool should restore the search that opened it.
    await owner.goBack();
    const restoredSearch=owner.getByRole('searchbox',{name:'Search CRM records'});
    await restoredSearch.waitFor();
    assert.equal(await restoredSearch.inputValue(),'pipeline');
    await owner.getByRole('region',{name:'Matching tools'}).getByRole('link',{name:'Pipeline settings'}).waitFor();
    await nav.getByRole('button',{name:'CRM',exact:true}).click();
    await restoredSearch.waitFor({state:'hidden'});
    await nav.getByRole('link',{name:'Contacts',exact:true}).waitFor();
    await owner.goto(origin+'/?view=workspaces#invite-teammate');
    await owner.locator('#invite-teammate[open]').getByRole('textbox',{name:'Teammate email',exact:true}).waitFor();
    await owner.locator('#invite-teammate > summary').click();
    for(const role of ['owner','backup']){
      await owner.goto(origin+'/?view=workspaces#workspace-role-guide-'+role);
      await owner.locator('.portable-role-guide[open] input[value="'+role+'"]:checked').waitFor({state:'attached'});
    }
    await owner.goto(origin+'/?view=workspaces#invite-teammate');
    await owner.goto(origin+'/?view=workspaces#workspace-role-guide-editor');
    await owner.locator('#workspace-role-guide input[value="editor"]:checked').waitFor({state:'attached'});
    await owner.goBack();
    await owner.locator('#invite-teammate[open]').getByRole('textbox',{name:'Teammate email',exact:true}).waitFor();
    await owner.waitForFunction(()=>document.activeElement===document.querySelector('#invite-teammate input[name="email"]'));
    await nav.getByRole('button',{name:'CRM',exact:true}).click();
    await nav.getByRole('link',{name:'Email templates',exact:true}).click();
    await owner.getByRole('heading',{name:'Email templates',level:1}).waitFor();
    assert.equal(new URL(owner.url()).searchParams.get('view'),'templates');
    await owner.getByRole('button',{name:'New template',exact:true}).click();
    const templateName='Navigation trial follow-up';
    await owner.getByLabel('Template name',{exact:true}).fill(templateName);
    await owner.getByLabel('Subject',{exact:true}).fill('Following up');
    await owner.getByLabel('Plain-text message',{exact:true}).fill('Thanks for the conversation.');
    await owner.getByRole('button',{name:'Save template',exact:true}).click();
    await owner.getByText('Template saved.',{exact:true}).waitFor();
    await owner.goto(origin+'/?view=email-settings#email-templates');
    await owner.locator('#email-templates').getByRole('button',{name:templateName,exact:true}).waitFor();
    assert.equal(await owner.getByRole('navigation',{name:'Settings navigation'}).getByRole('link',{name:'Email settings'}).getAttribute('aria-current'),'page');
    const target=owner.locator('#email-templates');
    await target.evaluate(element=>element.scrollIntoView({block:'start'}));
    const bar=await owner.locator('.portable-crm-header').boundingBox();
    assert.ok((await target.boundingBox()).y>=bar.y+bar.height,'The sticky header must leave the bookmarked section visible');
    assert.equal((await request('/?view=templates&workspaceId='+workspaceId,{headers:other})).status,404);
    await owner.getByText('Find in Harbor',{exact:true}).click();
    const ownerSearch=owner.getByRole('searchbox',{name:'Search CRM records'});
    const ownerTools=owner.getByRole('region',{name:'Matching tools'});
    for(const path of ['CRM → Quotes','Revenue / Quotes']){
      await ownerSearch.fill(path);
      const result=ownerTools.getByRole('link',{name:'Quotes',exact:true});
      await result.waitFor();
      assert.equal(await result.count(),1,path);
      assert.equal(await result.getAttribute('href'),'/quotes');
    }
    await ownerSearch.fill('data management');
    assert.equal(await ownerTools.getByRole('link').first().textContent(),'Data management settings');
    for(const [query,label,view] of [
      ['Reporting / Reports / Marketing analytics','Marketing analytics','web-attribution'],
      ['Settings > Job queue','Job queue','job-queue'],['Settings → Data management → API access','API access','api-access'],
      ['Settings / Workspace / Record access history','Record access history','record-access'],
      ['email settings','Email settings','email-settings'],['getting started','Getting started','getting-started'],['web attribution','Marketing analytics','web-attribution'],
    ]){
      await ownerSearch.fill(query);
      const link=ownerTools.getByRole('link',{name:label,exact:true});
      await link.click();
      assert.equal(new URL(owner.url()).searchParams.get('view'),view);
      if(view==='web-attribution')await owner.getByRole('heading',{level:1,name:'Marketing analytics',exact:true}).waitFor();
      else await owner.getByRole('navigation',{name:'Settings navigation'}).getByRole('link',{name:label,exact:true}).waitFor();
      await owner.getByText('Find in Harbor',{exact:true}).click();
    }
    for(const [query,label,section] of [['Settings / Data management / Objects / Pipelines','Pipeline settings','pipelines'],['Settings / Data management / Integrations','Integrations','integrations'],['object settings','Objects','objects'],['data management','Data management settings','data-management']]){
      await ownerSearch.fill(query);
      await ownerTools.getByRole('link',{name:label,exact:true}).click();
      assert.equal(new URL(owner.url()).searchParams.get('section'),section);
      assert.equal(await owner.getByRole('navigation',{name:'Settings navigation'}).locator('a[aria-current=page]').getAttribute('href'),'/?view=settings&section='+section);
      await owner.getByText('Find in Harbor',{exact:true}).click();
    }
    await ownerSearch.fill('team directory');
    await ownerTools.getByRole('link',{name:'Team directory',exact:true}).click();
    await owner.waitForFunction(()=>document.activeElement?.id==='team-directory');
    await owner.getByText('Find in Harbor',{exact:true}).click();
    await ownerSearch.fill('sales sequences');
    await ownerTools.getByRole('link',{name:'Sequences',exact:true}).click();
    assert.equal(new URL(owner.url()).searchParams.get('view'),'sequences');
    await owner.getByText('Find in Harbor',{exact:true}).click();
    await ownerSearch.fill('properties');
    await owner.getByRole('region',{name:'Matching tools'}).getByRole('link',{name:'Properties',exact:true}).click();
    assert.equal(new URL(owner.url()).searchParams.get('section'),'properties');
    await owner.getByText('Find in Harbor',{exact:true}).click();
    await owner.getByRole('searchbox',{name:'Search CRM records'}).fill('segments');
    await owner.getByRole('region',{name:'Matching tools'}).getByRole('link',{name:'Lists',exact:true}).click();
    assert.equal(new URL(owner.url()).searchParams.get('view'),'segments');
    await owner.getByRole('heading',{level:1,name:'Lists'}).waitFor();
    const listName='Navigation trial contacts';
    await owner.getByRole('form',{name:'List settings'}).getByLabel('Name',{exact:true}).fill(listName);
    const settingsForm=owner.getByRole('form',{name:'List settings'});
    await settingsForm.getByLabel('Name contains').fill('Navigation trial');
    await settingsForm.getByRole('button',{name:'Add OR group'}).click();
    await settingsForm.getByRole('button',{name:'Save list',exact:true}).click();
    await owner.getByText('Add a filter to each group or remove the empty group.',{exact:true}).waitFor();
    await settingsForm.getByRole('group',{name:'Or match group 2'}).getByLabel('Email contains').fill('second@example.test');
    await owner.getByRole('button',{name:'Save list',exact:true}).click();
    await owner.getByRole('heading',{name:'Edit '+listName,exact:true}).waitFor();
    assert.equal(await settingsForm.getByRole('group',{name:'Or match group 2'}).getByLabel('Email contains').inputValue(),'second@example.test');
    await settingsForm.getByRole('button',{name:'Remove group 1'}).click();
    assert.equal(await settingsForm.getByLabel('Email contains').inputValue(),'second@example.test');
    await settingsForm.getByRole('button',{name:'Save list',exact:true}).click();
    await owner.getByRole('heading',{name:'Members · 0',exact:true}).waitFor();
    await nav.getByRole('button',{name:'Automations',exact:true}).click();
    await nav.getByRole('link',{name:'Workflows',exact:true}).click();
    await owner.locator('select[name="trigger"]').selectOption({label:'Contact joins an active list'});
    await owner.getByLabel('Find an active contact list',{exact:true}).fill(listName);
    const listSearch=owner.waitForResponse(response=>new URL(response.url()).pathname==='/api/segments');
    await owner.getByRole('button',{name:'Find lists',exact:true}).click();
    assert.ok((await listSearch).ok());
    await owner.getByLabel('Active contact list',{exact:true}).selectOption({label:listName});
    const mobile=await session(other,{width:375,height:812});
    await owner.setViewportSize({width:375,height:812});
    await owner.goto(origin+'/?view=settings&section=pipelines');
    const pipelineTab=owner.getByRole('navigation',{name:'Settings navigation'}).getByRole('link',{name:'Pipelines'});
    await owner.waitForFunction(link=>{
      const strip=link.closest('nav').getBoundingClientRect(),tab=link.getBoundingClientRect();
      return tab.left>=strip.left&&tab.right<=strip.right;
    },await pipelineTab.elementHandle(),{timeout:3000});
    assert.equal(await owner.evaluate(()=>window.scrollY),0);
    const url=origin+'/?kind=deals&workspaceId='+workspaceId;
    await mobile.goto(url);
    await mobile.getByText('Find in Harbor',{exact:true}).click();
    const search=mobile.getByRole('searchbox',{name:'Search CRM records'});
    const toolResults=mobile.getByRole('region',{name:'Matching tools'});
    await search.fill('CRM');
    await toolResults.getByRole('button',{name:/Show all .* tools/}).click();
    assert.equal(await toolResults.getByRole('link',{name:'Inbox',exact:true}).getAttribute('href'),'/?view=team-inbox&workspaceId='+workspaceId);
    assert.equal(await toolResults.getByRole('link',{name:'Quotes',exact:true}).count(),0);
    await search.fill('Revenue / Quotes');
    assert.equal(await toolResults.getByRole('link',{name:'Quotes',exact:true}).count(),0);
    await search.fill('Service inbox');
    assert.equal(await toolResults.getByRole('link',{name:'Inbox',exact:true}).getAttribute('href'),'/?view=team-inbox&workspaceId='+workspaceId);
    await search.fill('settings');
    await toolResults.getByRole('link',{name:'Settings',exact:true}).click();
    await mobile.getByRole('heading',{name:'Your workspace access'}).waitFor();
    assert.equal(new URL(mobile.url()).searchParams.get('workspaceId'),workspaceId);
    await mobile.getByText('Find in Harbor',{exact:true}).click();
    await search.fill('workspaces');
    const switcherPath='/?view=workspaces&workspaceId='+workspaceId;
    const switcher=toolResults.getByRole('link',{name:'Workspaces',exact:true});
    assert.equal(await switcher.getAttribute('href'),switcherPath);
    await switcher.click();
    await mobile.getByRole('heading',{name:'Switch workspace'}).waitFor();
    assert.equal(await mobile.getByRole('link',{name:'Settings',exact:true}).getAttribute('href'),'/?view=settings&workspaceId='+workspaceId);
    assert.equal(await mobile.getByRole('link',{name:'Workspace from owner@example.test'}).getAttribute('href'),'/?workspaceId='+workspaceId);
    assert.equal(await mobile.getByRole('link',{name:'My workspace',exact:true}).getAttribute('href'),'/');
    const sharedRecord=mobile.getByRole('link',{name:'Workspace from owner@example.test'});
    await sharedRecord.click();
    assert.equal(new URL(mobile.url()).searchParams.get('workspaceId'),workspaceId);
    await mobile.getByRole('link',{name:'Workspaces',exact:true}).click();
    assert.equal(new URL(mobile.url()).pathname+new URL(mobile.url()).search,switcherPath);
    await mobile.getByText('Find in Harbor',{exact:true}).click();
    await search.fill('team inbox');
    const inbox=toolResults.getByRole('link',{name:'Inbox',exact:true});
    await inbox.waitFor();
    const inboxPath=new URL(await inbox.getAttribute('href'),origin);
    assert.equal(inboxPath.searchParams.get('workspaceId'),workspaceId);
    assert.equal(inboxPath.searchParams.get('view'),'team-inbox');
    for(const unavailable of ['products','customer portal','pipeline settings','record access history','job queue','api access','Settings → Data management → API access','Settings / Data management / Objects / Pipelines','getting started','web attribution','Reporting / Reports / Marketing analytics','email settings','object settings','data management','sales sequences','email marketing','campaigns']){
      await search.fill(unavailable);
      await toolResults.waitFor({state:'hidden'});
    }
    await search.press('Escape');
    const shared=mobile.getByRole('navigation',{name:'Main navigation'});
    await mobile.getByRole('button',{name:'Open navigation'}).click();
    await mobile.getByRole('button',{name:'Close navigation'}).click();
    await shared.waitFor({state:'hidden'});
    await mobile.getByRole('button',{name:'Open navigation'}).click();
    await checkMenuRoutes(shared,other,workspaceId);
    assert.deepEqual(await shared.locator('.portable-nav-category').allTextContents(),categories);
    // A short phone screen should reveal a destination as soon as its section opens.
    await mobile.setViewportSize({width:375,height:360});
    const reporting=shared.getByRole('button',{name:'Reporting',exact:true});
    await reporting.click();
    const firstReport=shared.getByRole('link',{name:'Dashboards',exact:true});
    await mobile.waitForFunction(link=>{
      const rect=link.getBoundingClientRect();
      const drawer=link.closest('nav').getBoundingClientRect();
      return rect.height>0&&rect.top>=drawer.top&&rect.bottom<=drawer.bottom;
    },await firstReport.elementHandle(),{timeout:3000});
    await mobile.setViewportSize({width:375,height:812});
    await shared.getByRole('button',{name:'CRM',exact:true}).click();
    await shared.getByRole('link',{name:'Tasks',exact:true}).waitFor();
    assert.equal(await shared.getByRole('link',{name:'Products',exact:true}).count(),0);
    await shared.getByRole('button',{name:'Service',exact:true}).click();
    await shared.getByRole('link',{name:'Help desk',exact:true}).click();
    await mobile.getByRole('heading',{name:'Help desk',level:1}).waitFor();
    assert.equal(new URL(mobile.url()).searchParams.get('workspaceId'),workspaceId);
    assert.equal(await mobile.getByRole('button',{name:'Create ticket'}).count(),0);
    await mobile.getByRole('button',{name:'Open navigation'}).click();
    await shared.getByRole('button',{name:'Sales',exact:true}).click();
    await shared.getByRole('link',{name:'Sales workspace',exact:true}).click();
    assert.equal(new URL(mobile.url()).searchParams.get('workspaceId'),workspaceId);
    assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    const sharedReports='/?view=reports&workspaceId='+workspaceId;
    const reportName='Quarterly pipeline by owner';
    const {item:report}=await write('/api/reporting',{action:'report',definition:{name:reportName,kind:'deals',groupBy:'recordOwner'}});
    const restrictedName='Quarterly confidential deal amounts';
    const {item:restricted}=await write('/api/reporting',{action:'report',definition:{name:restrictedName,kind:'deals',metric:'sum',measure:'amount'}});
    await write('/api/custom-properties',{action:'standardAccess',kind:'deals',id:'amount',audience:'owner',expectedRevision:0});
    const cards=[{reportId:report.id,wide:false},{reportId:restricted.id,wide:false}];
    await write('/api/reporting',{action:'dashboard',definition:{name:'Private board',cards}});
    await mobile.getByRole('button',{name:'Open navigation'}).click();
    await shared.getByRole('button',{name:'Reporting',exact:true}).click();
    await shared.getByRole('link',{name:'Reports',exact:true}).click();
    assert.equal(new URL(mobile.url()).search,new URL(sharedReports,origin).search);
    await mobile.getByText('No reports on shared dashboards on this page.').waitFor();
    for(const name of ['Team board','Second team board']){
      await write('/api/reporting',{action:'dashboard',teamVisible:true,definition:{name,cards}});
    }
    await mobile.reload();
    const searchReports=mobile.getByRole('searchbox',{name:'Search shared reports'});
    await searchReports.fill('Quarterly');
    await mobile.getByRole('button',{name:'Search',exact:true}).click();
    const reportLink=mobile.getByRole('link',{name:reportName,exact:true});
    await reportLink.waitFor();
    assert.equal(await reportLink.count(),1);
    assert.equal(await mobile.getByRole('link',{name:restrictedName,exact:true}).count(),0);
    assert.equal(await mobile.getByText('Private board',{exact:true}).count(),0);
    const dashboardHref=await reportLink.getAttribute('href');
    await reportLink.click();
    assert.equal(new URL(mobile.url()).href,new URL(dashboardHref,origin).href);
    assert.equal(await mobile.locator('article:target').count(),1,(await mobile.locator('main').innerText()).slice(0,1200));
    await mobile.locator('article:target').getByRole('heading',{name:reportName}).waitFor();
    assert.equal(new URL(mobile.url()).searchParams.get('workspaceId'),workspaceId);
    assert.equal((await request(sharedReports+'&reportId='+report.id,{headers:other})).status,404);
    assert.equal((await request('/?view=reports&workspaceId='+crypto.randomUUID(),{headers:other})).status,404);
    const updated=await write('/api/workspaces',{action:'role',id:grant,role:'editor'});
    const restrictedTeam=await write('/api/workspaces',{action:'record_scope',id:updated.viewers.find(item=>item.email==='other@example.test').id,viewScope:'owned',editScope:'owned'});
    await mobile.goto(url);
    await mobile.getByRole('button',{name:'Open navigation'}).click();
    await shared.getByRole('button',{name:'CRM',exact:true}).click();
    assert.ok(await shared.getByRole('link',{name:'Tasks',exact:true}).isVisible());
    assert.ok(await shared.getByRole('link',{name:'Companies',exact:true}).isVisible());
    await shared.getByRole('button',{name:'Automations',exact:true}).click();
    await shared.getByText('No tools available in this workspace.',{exact:true}).filter({visible:true}).waitFor();
    await verifyLargeWorkspaceSwitcher({sql,origin,mobile,workspaceId,request,other,headers});
    const membership=restrictedTeam.viewers.find(member=>member.email==='other@example.test');
    await write('/api/workspaces',{action:'revoke',id:membership.id});
    assert.equal((await request(switcherPath,{headers:other})).status,404);
    assert.equal((await request('/api/workspaces?joined=1&current='+workspaceId,{headers:other})).status,404);
  }finally{await browser.close();}
  await verifySalesWorkspace({request,origin,other,sql,signIn});
}

async function verifyLargeWorkspaceSwitcher({sql,origin,mobile,workspaceId,request,other,headers}){
  const [{id:member}]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  await sql`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
    SELECT 'nav-owner-'||i,'nav-owner-'||i,'group_'||i||'@example.test',1,1 FROM generate_series(1,106) i`;
  await sql`INSERT INTO private_workspaces(id,owner_id)
    SELECT ('be000000-0000-4000-a000-'||lpad(i::text,12,'0'))::uuid,'nav-owner-'||i FROM generate_series(1,106) i`;
  await sql`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id)
    SELECT id,${member},gen_random_uuid() FROM private_workspaces WHERE owner_id LIKE 'nav-owner-%'`;
  await mobile.goto(origin+'/?view=workspaces&workspaceId='+workspaceId);
  const list=mobile.locator('.portable-joined-workspaces');
  assert.equal(await list.getByRole('link').count(),25);
  await list.getByRole('button',{name:'Next workspaces'}).click();
  await list.getByRole('link',{name:'Workspace from group_26@example.test',exact:true}).waitFor();
  await list.getByRole('button',{name:'First workspaces'}).click();
  await list.getByRole('link',{name:'Workspace from group_1@example.test',exact:true}).waitFor();
  await list.getByLabel('Find a shared workspace').fill('GROUP_106@');
  await list.getByRole('button',{name:'Search workspaces'}).click();
  const last=list.getByRole('link',{name:'Workspace from group_106@example.test',exact:true});
  await last.waitFor();
  assert.equal(await list.getByRole('link').count(),1);
  await last.click();
  const remote='be000000-0000-4000-a000-000000000106';
  assert.equal(new URL(mobile.url()).searchParams.get('workspaceId'),remote);
  await mobile.getByRole('link',{name:'Workspaces',exact:true}).click();
  await mobile.getByRole('link',{name:/group_106@example.test.*Current workspace/}).waitFor();
  const page=async(auth,q)=>(await (await request('/api/workspaces?joined=1&q='+encodeURIComponent(q),{headers:auth})).json()).items;
  assert.equal((await page(headers,'group_106')).length,0);
  assert.equal((await page(other,'group%106')).length,0);
  assert.equal((await page(other,'group_106')).length,1);
  // Account-wide workspace management also exposes memberships past its initial batch.
  await mobile.getByRole('link',{name:'Manage my workspaces and invitations'}).click();
  await mobile.getByRole('heading',{name:'Workspaces',exact:true}).waitFor();
  await list.getByLabel('Find a shared workspace').fill('group_106');
  const queried=mobile.waitForResponse(r=>r.url().includes('/api/workspaces?joined=1')&&new URL(r.url()).searchParams.get('q')==='group_106');
  await list.getByRole('button',{name:'Search workspaces'}).click();
  const response=await queried;
  assert.equal(response.status(),200,await response.text());
  await last.waitFor();
}
