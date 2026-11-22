import assert from 'node:assert/strict';

export async function verifyStandardPropertyAccess({request,origin,get,post,checked,owner,other,kind,scope,team,member,assign,write}){
  const settings='/api/custom-properties';
  const name='Fictional standard field '+kind;
  const original='Confidential original '+kind,updated='Confidential team edit '+kind;
  const definition=(await checked(get(settings+'?kind='+kind,owner))).standardAccess.find(row=>row.id==='description');
  assert.deepEqual(definition,{id:'description',audience:'workspace',revision:0});
  const policy=(audience,expectedRevision,id='description')=>({action:'standardAccess',kind,id,audience,expectedRevision});
  const configure=(audience,expectedRevision)=>checked(post(settings,policy(audience,expectedRevision)));
  const restricted=(await configure(team,0)).property;
  assert.equal(restricted.audience,team);
  assert.ok(restricted.revision>0);
  assert.equal((await post(settings,policy('workspace',0))).status,409);
  assert.equal((await post(settings,policy('owner',0,'name'))).status,400);
  assert.equal((await post(settings+'?'+scope,policy('workspace',restricted.revision),other)).status,403);
  // The same employee is also the owner of an independent private workspace.
  assert.deepEqual((await checked(get(settings+'?kind='+kind,other))).standardAccess.find(row=>row.id==='description'),definition);

  const [sensitive,privateValue]={contacts:['mobilePhone','+1 202 555 0185'],companies:['annualRevenue',37412850],
    deals:['closedLostReason','Fictional confidential evaluation']}[kind];
  const ownerRule=(await checked(post(settings,policy('owner',0,sensitive)))).property;
  const qualifications={
    contacts:{postalCode:'02138',department:'Fictional partnerships',seniority:'Director',leadStatus:'Open deal',
      linkedinUrl:'https://example.test/contact-profile',website:'https://example.test/contact-site',preferredLanguage:'French',state:'Maine',timeZone:'America/New_York'},
    companies:{postalCode:'00501',companyType:'Partner',targetAccount:true,icpTier:'Tier 1',leadStatus:'Connected',
      industry:'Fictional confidential industry',linkedinUrl:'https://example.test/company-profile',state:'Maine',timeZone:'America/New_York',yearFounded:1983},
    deals:{dealType:'Existing business',priority:'High',closeDate:'2034-08-19',forecastCategory:'Commit'},
  }[kind];
  for(const id of Object.keys(qualifications))await checked(post(settings,policy(team,0,id)));
  const amount=8726193.45;
  const amountRule=kind==='deals'?(await checked(post(settings,policy(team,0,'amount')))).property:null;
  const group={id:crypto.randomUUID(),name:'Confidential review '+kind};
  const organize=(revision,change)=>checked(post('/api/property-groups',{kind,revision,change}));
  const organization=await checked(get('/api/property-groups?kind='+kind,owner));
  const createdGroup=await organize(organization.revision,{action:'create',...group});
  await organize(createdGroup.revision,{action:'move',group:group.id,fields:['description']});
  const record=(await checked(post('/api/crm',{action:'save',kind,data:{name,description:original,[sensitive]:privateValue,...qualifications,...(amountRule?{amount}:{})}}),201)).record;
  const ref='/api/crm?kind='+kind+'&id='+record.id;
  const read=()=>checked(get(ref+'&'+scope));
  const history='/api/crm?kind='+kind+'&history='+record.id+'&'+scope;
  const view={action:'create',kind,name:name+' view',filters:{search:name},columns:['name','description']};
  const saved=(await checked(post('/api/crm/views',view),201)).view;
  await checked(post('/api/crm/views',{action:'setSharing',id:saved.id,kind,expectedRevision:saved.revision,shared:true}));
  const readView=async()=>(await checked(get('/api/crm/views?kind='+kind+'&'+scope))).views.find(row=>row.id===saved.id);
  const catalog=async()=>(await checked(get(settings+'?kind='+kind+'&'+scope))).standardAccess.map(row=>row.id);
  const search=term=>checked(post('/api/crm/search?'+scope,{kind,query:term},other));
  const edit=(revision,data)=>post(write,{action:'save',kind,id:record.id,expectedRevision:revision,data:{name,...data}},other);
  await assign(team,null);
  assert.ok((await catalog()).includes('description'));
  const allowed=(await read()).data;
  assert.equal(allowed.description,original);
  for(const [id,value] of Object.entries(qualifications))assert.equal(allowed[id],value,id);
  assert.ok(!Object.hasOwn(allowed,sensitive));
  assert.equal((await get(history+'&field='+sensitive)).status,404);
  // Number fields accept null as an ordinary clear. That must still require field access.
  const clear=typeof privateValue==='number'?null:'';
  assert.equal((await edit(record.revision,{[sensitive]:clear})).status,403);
  assert.equal((await checked(get(history+'&field=description'))).items[0].value,original);
  assert.deepEqual((await readView()).columns,view.columns);
  assert.equal((await search(original)).total,1);
  if(kind!=='deals')assert.equal((await search(qualifications.linkedinUrl)).total,1);
  if(amountRule)assert.equal(allowed.amount,amount);
  const teamEdit=(await checked(edit(record.revision,{description:updated}))).record;
  assert.equal(teamEdit.data.description,updated);

  // Removing the team leaves the session and record editable, but cuts off every path to the field.
  await assign(null,team);
  assert.ok(!(await catalog()).includes('description'));
  if(kind==='companies'){
    await verifyCompanyIndustryReport({get,post,checked,owner,scope,record,team,assign});
  }
  const afterRemoval=(await read()).data;
  assert.ok(!Object.hasOwn(afterRemoval,'description'));
  for(const id of Object.keys(qualifications)){
    assert.ok(!Object.hasOwn(afterRemoval,id),id);
    assert.equal((await get(history+'&field='+id)).status,404,id);
    assert.equal((await edit(teamEdit.revision,{[id]:qualifications[id]})).status,403,id);
  }
  const list=await checked(get('/api/crm?kind='+kind+'&search='+encodeURIComponent(name)+'&'+scope));
  const listed=list.records.find(row=>row.id===record.id);
  assert.ok(listed&&!Object.hasOwn(listed.data,'description'));
  const recordPage='/?'+(kind==='contacts'?'contact='+record.id:'kind='+kind+'&record='+record.id)+'&'+scope;
  for(const path of [recordPage,'/?kind='+kind+'&savedView='+saved.id+'&'+scope]){
    const response=await get(path);
    assert.equal(response.status,200,path);
    const html=await response.text();
    assert.ok(!html.includes(group.name),'A hidden field exposed its private property group');
    assert.ok(!html.includes(original)&&!html.includes(updated),'Private field appeared in rendered page '+path);
  }
  assert.deepEqual((await readView()).columns,['name']);
  assert.equal((await post('/api/crm/views?'+scope+'&grantId='+member.id,view,other)).status,400);
  assert.equal((await get(history+'&field=description')).status,404);
  assert.ok(!(await checked(get(history))).items.some(change=>change.field==='description'));
  assert.deepEqual((await checked(get(history+'&search='+encodeURIComponent(original)))).items,[]);
  assert.equal((await search(updated)).total,0);
  if(kind!=='deals')assert.equal((await search(qualifications.linkedinUrl)).total,0);
  for(const description of [updated,'']){
    assert.equal((await edit(teamEdit.revision,{description})).status,403);
  }
  assert.equal((await post(write,{action:'editProperty',kind,field:'description',mode:'replace',value:updated,
    records:[{id:record.id,expectedRevision:teamEdit.revision}]},other)).status,403);
  assert.equal((await post(write,{action:'save',kind,data:{name:name+' unauthorized create',description:updated}},other)).status,403);
  if(kind==='deals'){
    await verifyDealAmount({get,post,checked,owner,other,scope,member,edit,amount,record,assign,team,revision:teamEdit.revision});
    const {pipeline}=await checked(post('/api/pipeline',{name:'Description approval trial',stages:[
      {name:'Review',outcome:'open'},{name:'Confirmed',outcome:'won',requiredProperties:[{field:'description',required:true}]},
      {name:'Rejected',outcome:'lost'},
    ]}),201);
    const move=await post(write,{action:'save',kind,id:record.id,expectedRevision:teamEdit.revision,data:{name},
      pipelineId:pipeline.id,stageId:pipeline.stages[1].id},other);
    assert.equal(move.status,403,await move.clone().text());
    await verifyFollowUpCard({get,post,checked,owner,other,scope,policy,settings,team,assign});
  }
  const renamed=(await checked(edit(teamEdit.revision,{name:name+' revised'}))).record;
  assert.ok(!Object.hasOwn(renamed.data,'description'));

  const {token}=await checked(post('/api/api-tokens',{name:name+' token',permissions:{[kind]:'read_write'},days:30}),201);
  const bearer={authorization:'Bearer '+token};
  const records='/api/v1/records/'+kind,external=records+'/'+record.id;
  const detail=await checked(get(external,bearer));
  assert.ok(!Object.hasOwn(detail.properties,'description'));
  const batch=await checked(post(records+'/batch/read',{inputs:[{id:record.id}]},bearer));
  assert.equal(batch.results[0].id,record.id);
  assert.ok(!Object.hasOwn(batch.results[0].properties,'description'));
  const patch=properties=>request(external,{method:'PATCH',headers:{...bearer,'if-match':detail.etag,'content-type':'application/json'},
    body:JSON.stringify({properties})});
  assert.equal((await patch({description:updated})).status,403);
  if(amountRule){
    assert.equal((await patch({amount:0})).status,403);
    assert.equal((await patch({closeDate:''})).status,403);
  }
  const patched=await checked(patch({name:name+' synchronized'}));
  assert.ok(!Object.hasOwn(patched.properties,'description'));
  const preserved=await checked(get(ref,owner));
  assert.equal(preserved.data.name,name+' synchronized');
  assert.equal(preserved.data.description,updated);
  if(amountRule){
    assert.equal(preserved.data.amount,amount);
    assert.ok(!Object.hasOwn(patched.properties,'amount'));
    assert.ok(!Object.hasOwn(batch.results[0].properties,'amount'));
  }
  assert.equal(preserved.data[sensitive],privateValue);
  for(const [id,value] of Object.entries(qualifications)){
    assert.equal(preserved.data[id],value,id);
    assert.ok(!Object.hasOwn(patched.properties,id)&&!Object.hasOwn(batch.results[0].properties,id),id);
  }
  // Returning to the team immediately exposes both the value and its actual change history.
  await assign(team,null);
  assert.equal((await read()).data.description,updated);
  assert.ok((await (await get(recordPage)).text()).includes(group.name),'A teammate with field access can see its property group');
  const changes=await checked(get(history+'&field=description'));
  assert.deepEqual(changes.items.map(({previous,value})=>[previous,value]),[[original,updated],[null,original]]);
  const ownerAmount=amountRule?(await checked(post(settings,policy('owner',amountRule.revision,'amount')))).property:null;
  await verifySettingsAndEditor({origin,owner,other,kind,recordPage,updated});
  const {standardAccess}=await checked(get(settings+'?kind='+kind,owner));
  const ownerOnly=standardAccess.find(row=>row.id==='description');
  assert.equal(ownerOnly.audience,'owner');
  assert.ok(!Object.hasOwn((await read()).data,'description'));
  if(ownerAmount){
    const afterEdit=await checked(get(ref,owner));
    assert.equal(afterEdit.data.amount,amount);
    assert.equal(afterEdit.data.closeDate,qualifications.closeDate);
    assert.equal(afterEdit.data.name,'Deal edited without pricing access');
    await checked(post(settings,policy('workspace',ownerAmount.revision,'amount')));
  }
  for(const rule of standardAccess.filter(row=>Object.hasOwn(qualifications,row.id))){
    await checked(post(settings,policy('workspace',rule.revision,rule.id)));
  }
  if(kind==='deals'){
    const current=await read();
    const cleared=await checked(edit(current.revision,{closeDate:''}));
    assert.equal(cleared.record.data.closeDate,'');
    assert.equal((await checked(get(ref,owner))).data.closeDate,'');
  }
  if(kind==='deals'){
    const stagePolicy=audience=>({action:'standardAccess',kind,id:'stage',audience});
    const stageRule=standardAccess.find(row=>row.id==='stage');
    assert.equal(stageRule.audience,'owner');
    const preview=()=>get('/?view=settings&section=properties&member='+member.id,owner).then(response=>response.text());
    assert.match(await preview(),/This teammate cannot move deals between stages/);
    const existing=await read();
    const closed='Closed won',move=()=>edit(existing.revision,{stage:closed});
    assert.equal((await move()).status,403);
    const send=(body)=>post(write,{kind,...body},other);
    assert.equal((await send({action:'editProperty',field:'stage',mode:'replace',value:closed,
      records:[{id:existing.id,expectedRevision:existing.revision}]})).status,403);
    assert.equal((await send({action:'save',data:{name:'Unapproved late-stage deal',stage:closed}})).status,403);
    const {record:fresh}=await checked(send({action:'save',data:{name:'New first-stage deal'}}),201);
    assert.equal(fresh.data.stage,'Appointment scheduled');
    const {pipeline}=await checked(post('/api/pipeline',{name:'Rep stage permissions',stages:[
      {name:'Discovery',outcome:'open'},{name:'Signed',outcome:'won'},{name:'Declined',outcome:'lost'},
    ]}),201);
    const [first,last]=pipeline.stages;
    const placement={pipelineId:pipeline.id,stageId:first.id};
    const draft={action:'save',...placement,data:{name:'Custom entry stage'}};
    assert.equal((await send({...draft,stageId:last.id})).status,403);
    const placed=(await checked(send(draft),201)).record;
    assert.equal(placed.stageId,first.id);
    assert.equal((await send({...draft,id:existing.id,expectedRevision:existing.revision})).status,403);
    assert.equal((await send({...draft,id:placed.id,expectedRevision:placed.revision,stageId:last.id})).status,403);
    assert.equal((await read()).revision,existing.revision);
    const teamRule=(await checked(post(settings,{...stagePolicy(team),expectedRevision:stageRule.revision}))).property;
    assert.match(await preview(),/This teammate can move deals they can edit/);
    const won=(await checked(move())).record;
    assert.equal(won.data.stage,closed);
    await assign(null,team);
    const kept=(await checked(edit(won.revision,{name:'Renewal at the existing stage'}))).record;
    assert.equal(kept.data.stage,closed);
    assert.equal((await edit(kept.revision,{stage:'Closed lost'})).status,403);
    await checked(post(settings,{...stagePolicy('workspace'),expectedRevision:teamRule.revision}));
    await assign(team,null);
  }
  await configure('workspace',ownerOnly.revision);
  await checked(post(settings,policy('workspace',ownerRule.revision,sensitive)));
  assert.equal((await read()).data.description,updated);
  await assign(null,team);
}

async function verifyCompanyIndustryReport({get,post,checked,owner,scope,record,team,assign}){
  const {record:deal}=await checked(post('/api/crm',{action:'save',kind:'deals',companyId:record.id,data:{name:'Industry report trial'}}),201);
  const reporting='/api/reporting';
  const {item:report}=await checked(post(reporting,{action:'report',definition:{kind:'deals',name:'Deals by industry',groupBy:'associated:industry'}}),201);
  const {item:dashboard}=await checked(post(reporting,{action:'dashboard',definition:{name:'Industry overview',cards:[{reportId:report.id,wide:false}]},teamVisible:true}),201);
  const url=reporting+'?view=dashboard&id='+dashboard.id;
  const drill=reporting+'?view=dashboardRecords&id='+dashboard.id+'&reportId='+report.id+'&'+scope+'&group='+encodeURIComponent(record.data.industry);
  const [hidden]=(await checked(get(url+'&'+scope))).cards;
  assert.equal(hidden.missing,true);
  assert.ok(!hidden.result&&!hidden.definition);
  assert.equal((await get(drill)).status,404);
  const [ownerCard]=(await checked(get(url,owner))).cards;
  assert.ok(ownerCard.result.rows.some(row=>row.label===record.data.industry));
  await assign(team,null);
  const [visible]=(await checked(get(url+'&'+scope))).cards;
  assert.ok(visible.result.rows.some(row=>row.label===record.data.industry));
  const matches=await checked(get(drill));
  assert.ok(matches.records.some(row=>row.id===deal.id));
  await assign(null,team);
}

async function verifyDealAmount({get,post,checked,owner,other,scope,member,edit,amount,record,assign,team,revision}){
  assert.equal((await edit(revision,{amount:0})).status,403);
  assert.equal((await edit(revision,{closeDate:''})).status,403);
  const history='/api/crm?kind=deals&history='+record.id;
  assert.equal((await get(history+'&field=amount&'+scope)).status,404);
  assert.ok(!(await checked(get(history+'&'+scope))).items.some(change=>change.field==='amount'));
  const shared=await checked(get('/api/crm?kind=deals&id='+record.id+'&'+scope));
  assert.ok(!Object.hasOwn(shared.data,'amount'));
  const month=record.data.closeDate.slice(0,7),filtered='/api/crm?kind=deals&search='+encodeURIComponent(record.data.name)+'&closeMonth='+month;
  assert.deepEqual((await checked(get(filtered+'&'+scope))).records,[]);
  assert.ok((await checked(get(filtered,owner))).records.some(row=>row.id===record.id));
  const views='/api/crm/views',selection={action:'create',kind:'deals',name:'Deals closing in August',filters:{closeMonth:month}};
  assert.equal((await post(views+'?'+scope+'&grantId='+member.id,selection,other)).status,400);
  const {view:saved}=await checked(post(views,selection),201);
  await checked(post(views,{action:'setSharing',kind:'deals',id:saved.id,expectedRevision:saved.revision,shared:true}));
  const visibleViews=async()=>(await checked(get(views+'?kind=deals&'+scope))).views;
  assert.ok(!(await visibleViews()).some(row=>row.id===saved.id));
  const filteredView='/?kind=deals&savedView='+saved.id+'&'+scope;
  assert.equal((await get(filteredView)).status,404);
  const path='/?kind=deals&pipelineId=default&view=';
  for(const view of ['board','summary']){
    const filter=view==='board'?'&search='+encodeURIComponent(record.data.name):'';
    const response=await get(path+view+filter+'&'+scope);
    assert.equal(response.status,200);
    const html=await response.text();
    assert.ok(!html.includes(String(amount))&&!html.includes(amount.toLocaleString('en-US')));
    assert.ok(!html.includes(record.data.closeDate));
    assert.equal((await get(path+view+'&closeMonth='+month+'&'+scope)).status,404);
    if(view==='summary'){
      assert.ok(!html.includes('name="closeMonth"'));
      assert.ok(!html.includes('Weighted open'));
      assert.ok((await (await get(path+view,owner)).text()).includes('Weighted open'));
    }else{
      assert.ok(html.includes(record.data.name));
      assert.ok(!html.includes('class="portable-deal-card-amount"'));
    }
  }
  const reporting='/api/reporting';
  const report=async(name,measure)=>(await checked(post(reporting,{action:'report',definition:{name,kind:'deals',
    ...(measure?{metric:'sum',measure}:{})}}),201)).item;
  const count=await report('Open deal count'),sum=await report('Total deal amount','amount');
  const dated=(await checked(post(reporting,{action:'report',definition:{kind:'deals',name:'August pipeline',
    filter:{field:'closeDate',operator:'between',value:'2034-08-01',valueTo:'2034-08-31'}}}),201)).item;
  const definition={name:'Team pipeline',cards:[count,sum,dated].map(item=>({reportId:item.id,wide:false}))};
  const {item}=await checked(post(reporting,{action:'dashboard',definition,teamVisible:true}),201);
  const url=reporting+'?view=dashboard&id='+item.id;
  assert.deepEqual((await checked(get(url+'&'+scope))).cards.map(card=>card.missing),[false,true,true]);
  assert.deepEqual((await checked(get(url,owner))).cards.map(card=>card.missing),[false,false,false]);
  const drill=reporting+'?view=dashboardRecords&id='+item.id+'&'+scope+'&reportId=';
  assert.equal((await get(drill+sum.id,other)).status,404);
  assert.equal((await get(drill+dated.id,other)).status,404);
  assert.equal((await get(drill+count.id,other)).status,200);
  await assign(team,null);
  assert.ok((await visibleViews()).some(row=>row.id===saved.id));
  assert.ok((await checked(get(filtered+'&'+scope))).records.some(row=>row.id===record.id));
  assert.equal((await get(drill+dated.id,other)).status,200);
  const authorized=await checked(get(url+'&'+scope));
  assert.deepEqual(authorized.cards.map(card=>card.missing),[false,false,false]);
  assert.equal(authorized.cards[1].result.total,(await checked(get(url,owner))).cards[1].result.total);
  assert.equal((await get(drill+sum.id,other)).status,200);
  const summary=await get(path+'summary&'+scope);
  assert.ok((await summary.text()).includes('Weighted open'));
  await assign(null,team);
}

async function verifyFollowUpCard({get,post,checked,owner,other,scope,policy,settings,team,assign}){
  const path='/?view=dashboards';
  const card=async(shared=false)=>{
    const response=await get(shared?path+'&'+scope:path,shared?other:owner);
    assert.equal(response.status,200);
    return (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  };
  const heading='<h3>Deals without a next step</h3>';
  const {property}=await checked(post(settings,policy(team,0,'nextStep')));
  assert.ok((await card()).includes(heading));
  assert.ok(!(await card(true)).includes(heading));
  await assign(team,null);
  const eligible=await card(true);
  const start=eligible.indexOf(heading);
  assert.ok(start>=0);
  assert.match(eligible.slice(start).split('</article>')[0],/<li><a[^>]*href="[^"]*kind=deals/);
  await assign(null,team);
  await checked(post(settings,policy('workspace',property.revision,'nextStep')));
}

async function verifySettingsAndEditor({origin,owner,other,kind,recordPage,updated}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  async function open(auth){
    const context=await browser.newContext();
    const [name,value]=auth.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    page.setDefaultTimeout(10000);
    return page;
  }
  const label=kind==='deals'?'Deal description':'Description';
  try{
    const admin=await open(owner),member=await open(other);
    await member.goto(origin+recordPage);
    const all=member.getByRole('button',{name:'View all properties',exact:true});
    const dialog=member.getByRole('dialog',{name:'All properties'});
    await all.click();
    await dialog.getByText(updated,{exact:true}).waitFor();
    await member.keyboard.press('Escape');
    await admin.goto(origin+'/?view=workspaces');
    const person=admin.locator('details.portable-access-member').filter({hasText:'other@example.test'});
    await person.locator('summary').first().click();
    await person.getByRole('link',{name:'Preview record and field access'}).click();
    await admin.getByRole('heading',{name:'Record and field access for other@example.test'}).waitFor();
    const preview=admin.getByRole('region',{name:kind[0].toUpperCase()+kind.slice(1),exact:true});
    await preview.locator('dl > div').filter({has:admin.getByText(label,{exact:true})}).getByText('Visible',{exact:true}).waitFor();
    await preview.getByRole('link',{name:'Manage '+kind+' properties'}).click();
    const [field,fieldLabel]={contacts:['seniority','Seniority'],companies:['targetAccount','Target account'],deals:['priority','Priority']}[kind];
    const profileLabels={contacts:['LinkedIn URL'],companies:['Industry'],deals:['Close date','Forecast category']};
    for(const restrictedLabel of [label,fieldLabel,...profileLabels[kind]]){
      await admin.getByRole('button',{name:'Change visibility of '+restrictedLabel,exact:true}).click();
      await admin.getByRole('combobox',{name:/Who can see/}).selectOption('owner');
      await admin.getByRole('button',{name:'Save visibility',exact:true}).click();
      await admin.getByText('Visibility saved.',{exact:true}).waitFor();
    }
    if(kind==='deals'){
      await admin.getByRole('button',{name:'Change who can move deals'}).click();
      await admin.getByRole('combobox',{name:/Who can change deal stages/}).selectOption('owner');
      await admin.getByRole('button',{name:'Save stage permissions'}).click();
      await admin.getByText('Stage permissions saved.',{exact:true}).waitFor();
      await member.goto(origin+'/?kind=deals&view=board&workspaceId='+new URL(recordPage,origin).searchParams.get('workspaceId'));
      await member.getByRole('region',{name:/board/}).waitFor();
      assert.equal(await member.getByRole('button',{name:'Move',exact:true}).count(),0);
      await member.goto(origin+recordPage);
    }
    await member.reload();
    await all.click();
    await dialog.getByRole('searchbox').fill(label);
    assert.ok(!(await dialog.locator('dt').allTextContents()).includes(label));
    await member.keyboard.press('Escape');
    await member.getByRole('button',{name:'Edit all properties',exact:true}).click();
    const editor=member.locator('form.portable-record-editor');
    await editor.waitFor();
    assert.equal(await editor.locator('[name=description]').count(),0);
    assert.equal(await editor.locator('[name='+field+']').count(),0);
    const privateField={contacts:'linkedinUrl',companies:'industry',deals:'forecastCategory'}[kind];
    assert.equal(await editor.locator('[name='+privateField+']').count(),0);
    if(kind==='deals'){
      assert.ok(await editor.locator('select[name=stageSelection]').isDisabled());
      assert.ok(await editor.locator('select[name=pipelineId]').isDisabled());
      assert.equal(await editor.locator('[name=amount]').count(),0);
      assert.equal(await editor.locator('[name=closeDate]').count(),0);
      await editor.locator('[name=name]').fill('Deal edited without pricing access');
      const saving=member.waitForResponse(response=>new URL(response.url()).pathname==='/api/crm'&&response.request().method()==='POST');
      await editor.getByRole('button',{name:/Save deal/i}).click();
      assert.equal((await saving).status(),200);
    }
  }finally{
    await browser.close();
  }
}
