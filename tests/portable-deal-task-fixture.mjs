import assert from 'node:assert/strict';

export async function verifyDealTaskHandoff({request,origin,headers,other,sql}){
  const post=async(path,data,auth=headers)=>{
    const response=await request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(data)});
    assert.ok(response.ok,await response.clone().text());
    return response.json();
  };
  await sql`UPDATE login_identities SET full_name=CASE email WHEN 'owner@example.test' THEN 'Morgan Sales' ELSE 'Casey Support' END
    WHERE email IN ('owner@example.test','other@example.test')`;
  const {record:deal}=await post('/api/crm',{action:'save',kind:'deals',data:{name:'Fictional renewal'}});
  const {owned:workspaceId,viewers}=await post('/api/workspaces',{action:'grant',email:'other@example.test'});
  const member=viewers.find(row=>row.email==='other@example.test');
  const {viewers:editors}=await post('/api/workspaces',{action:'role',id:member.id,role:'editor'});
  const editor=editors.find(row=>row.email==='other@example.test');
  const dealPage='/?kind=deals&record='+deal.id;
  const detail='/api/crm?kind=tasks&recordKind=deals&completionHistoryFor='+deal.id;
  const history=async()=> (await request(detail,{headers})).json();
  assert.equal((await request(detail,{headers:other})).status,404);

  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME,headless:true});
  const open=async(auth,width,height)=>{
    const ctx=await browser.newContext({viewport:{width,height},isMobile:width<500,hasTouch:width<500});
    const [name,value]=auth.cookie.split('=');
    await ctx.addCookies([{name,value,url:origin}]);
    return ctx.newPage();
  };
  async function newNameInView(page){
    await page.waitForFunction(()=>{
      const name=document.querySelector('.portable-task-editor input[name="name"]');
      if(document.activeElement!==name||!name)return false;
      const {top,bottom}=name.getBoundingClientRect();
      return top>=0&&bottom<=window.innerHeight;
    },null,{timeout:8000});
    return page.getByRole('form',{name:'New task'}).getByRole('textbox',{name:'Name',exact:true});
  }
  try{
    const owner=await open(headers,390,844),teammate=await open(other,1365,880);
    await owner.goto(origin+dealPage);
    await owner.getByRole('link',{name:'Add task',exact:true}).click();
    const name=await newNameInView(owner);
    await name.fill('Review renewal terms');
    await owner.getByLabel('Assigned to').selectOption({label:'Morgan Sales'});
    await owner.getByRole('button',{name:'Save task'}).click();
    await owner.waitForURL(url=>url.searchParams.has('record')&&url.searchParams.get('kind')==='tasks');
    const taskId=new URL(owner.url()).searchParams.get('record');
    const taskPath='/?kind=tasks&workspaceId='+workspaceId+'&record='+taskId;
    await teammate.goto(origin+taskPath);
    await teammate.getByRole('button',{name:'Mark complete'}).click();
    await teammate.getByRole('button',{name:'Reopen task'}).waitFor();
    await owner.goto(origin+dealPage);
    await owner.getByRole('link',{name:'Task history',exact:true}).click();
    const timeline=owner.getByRole('region',{name:'Task completion history'});
    await timeline.getByText(/Completed by Casey Support/).waitFor();
    assert.equal((await history()).items[0].id,taskId);
    assert.equal(await timeline.locator('time').count(),1);
    await teammate.getByRole('button',{name:'Reopen task'}).click();
    await teammate.getByRole('button',{name:'Mark complete'}).waitFor();
    await owner.goto(origin+'/?kind=tasks&record='+taskId);
    await owner.getByRole('button',{name:'Mark complete'}).click();
    await owner.getByRole('button',{name:'Reopen task'}).waitFor();
    assert.deepEqual((await history()).items.map(row=>row.actorName),['Morgan Sales','Casey Support']);
    const current=await (await request('/api/crm?kind=tasks&id='+taskId,{headers})).json();
    const {record:contact}=await post('/api/crm',{kind:'contacts',action:'save',data:{name:'Renewal contact'}});
    await post('/api/crm',{kind:'tasks',action:'save',id:taskId,expectedRevision:current.revision,
      data:current.data,related:{kind:'contacts',id:contact.id}});
    assert.deepEqual((await history()).items.map(row=>row.actorName),['Morgan Sales','Casey Support']);
    const contactHistory=await request('/api/crm?kind=tasks&completionHistoryFor='+contact.id,{headers});
    assert.deepEqual(await contactHistory.json(),{items:[],next:null});
    await owner.setViewportSize({width:320,height:568});
    await owner.goto(origin+'/?kind=tasks');
    await owner.getByRole('button',{name:'Add task',exact:true}).click();
    await newNameInView(owner);
    await owner.getByRole('button',{name:'Cancel',exact:true}).click();
    await owner.getByRole('button',{name:'Add task',exact:true}).click();
    await newNameInView(owner);
    await post('/api/workspaces',{action:'revoke',id:editor.id});
    assert.equal((await request(detail+'&workspaceId='+workspaceId,{headers:other})).status,404);
    assert.equal((await history()).items[1].actorName,null);
  }finally{await browser.close();}
}
