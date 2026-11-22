import assert from 'node:assert/strict';

export async function verifyRecordOwnerHandoffs({origin,read,get,post,change,make,scope,headers,other,rep,repId,peer,peerId,peerContactId}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage(),[name,value]=other.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    for(const kind of ['contacts','companies','deals']){
      const title='Fictional handoff '+kind;
      const month='2032-07';
      const row=await make(kind,title,peerId,kind==='deals'?{data:{name:title,stage:'Closed won',amount:351,closeDate:month+'-06'}}:{});
      const set=async edit=>{
        const result=await change({action:'tool_permissions',ids:[peer.id],tool:kind,
          policy:{view:'all',edit,create:true,delete:edit!=='none'}});
        peer=result.viewers.find(m=>m.actorId===peerId);
      };
      const filters=new URLSearchParams({kind,search:title,owner:'unavailable'});
      const list='/api/crm?'+filters;
      const batch={action:'assignOwners',kind,assigneeId:peerId,records:[{id:row.id,expectedRevision:row.revision}]};
      await set('none');
      assert.deepEqual((await read(get(list,headers))).records.map(r=>r.id),[row.id]);
      const csv=await get(list+'&export=csv',headers);
      assert.equal(csv.status,200);
      assert.ok((await csv.text()).includes(title));
      assert.equal((await post('/api/crm',headers,{action:'save',kind,data:{name:'Refused assignment'},assigneeId:peerId})).status,409);
      assert.equal((await post('/api/crm?'+scope+'&grantId='+rep.id,other,batch)).status,409);
      if(kind==='deals'){
        const contact=await read(get('/api/crm?kind=contacts&id='+peerContactId,headers));
        const unchanged=await read(post('/api/crm',headers,{...batch,kind:'contacts',
          records:[{id:contact.id,expectedRevision:contact.revision}]}));
        assert.equal(unchanged.changed,0,'The rep can still receive Contacts.');
        await page.goto(origin+'/?view=forecast&month='+month+'&'+scope);
        const contributions=page.getByRole('table',{name:'Forecast by deal owner'});
        assert.deepEqual(await contributions.getByRole('row',{name:/Unavailable owners/}).getByRole('cell').allTextContents(),['351.00','0.00','351.00']);
        assert.equal(await page.getByLabel('Deal owner').locator('option[value="'+peerId+'"]').count(),0);
        const goal={month,owner:peerId,pipelineId:'default',revision:0,amountCents:1};
        assert.equal((await post('/api/forecast-targets',headers,goal)).status,404);
      }
      await set('owned');
      assert.deepEqual((await read(get(list,headers))).records,[]);
      await set('none');
      // The team manager can still repair a subordinate's existing records in the bulk UI.
      await page.goto(origin+'/?'+filters+'&'+scope);
      await page.getByRole('checkbox',{name:'Select '+title}).check();
      const form=page.getByRole('form',{name:'Assign an owner to selected '+kind});
      const picker=form.getByLabel('Record owner');
      assert.equal(await picker.locator('option[value="'+peerId+'"]').count(),0);
      await picker.selectOption(repId);
      await form.getByRole('button',{name:'Assign owner'}).click();
      await page.getByRole('checkbox',{name:'Select '+title}).waitFor({state:'detached'});
      const saved=await read(get('/api/crm?kind='+kind+'&id='+row.id,headers));
      assert.equal(saved.data.recordOwner.userId,repId);
      assert.equal(saved.revision,row.revision+1);
      await set('all');
      await read(post('/api/recycle-bin',headers,{action:'archive',kind,id:row.id,expectedRevision:saved.revision,requestId:crypto.randomUUID()}));
    }
    const api='/api/custom-objects',objectId=crypto.randomUUID(),id=crypto.randomUUID();
    const title='Fictional onboarding handoff';
    await read(post(api,headers,{action:'define',id:objectId,revision:0,definition:{name:'Handoff projects',fields:[]}}));
    const save={action:'save',objectId,id,revision:0,schemaRevision:1,name:title,assigneeId:peerId};
    await read(post(api,headers,save));
    await read(post(api,headers,{...save,id:crypto.randomUUID(),name:'Unassigned project',assigneeId:null}));
    const setCustom=async edit=>{
      const directory=await change({action:'tool_permissions',ids:[peer.id],tool:'custom-objects',policy:{view:'all',edit,create:true,delete:edit!=='none'}});
      peer=directory.viewers.find(m=>m.actorId===peerId);
    };
    const queue='?owner=unavailable&objectId='+objectId;
    await setCustom('none');
    assert.deepEqual((await read(get(api+queue,headers))).items.map(r=>r.id),[id]);
    const csv=await get(api+queue+'&export=csv',headers);
    assert.equal(csv.status,200);
    assert.deepEqual((await csv.text()).trim().split('\r\n').map(line=>line.split(',')[1]),['"Name"','"'+title+'"']);
    const catalog=await read(get(api+'?owner=unavailable&'+scope));
    assert.ok(catalog.items.some(type=>type.id===objectId));
    assert.equal((await page.goto(origin+'/?view=custom-objects&owner=unavailable&'+scope)).status(),200);
    await page.getByRole('link',{name:'Handoff projects'}).click();
    await page.getByRole('link',{name:title}).click();
    await page.getByRole('link',{name:'Reassign record'}).click();
    const owner=page.getByLabel('Record owner');
    assert.equal(await owner.locator('option[value="'+peerId+'"]').count(),0);
    await owner.selectOption(repId);
    await setCustom('owned');
    await page.getByRole('button',{name:'Save new owner'}).click();
    await page.getByRole('alert').filter({hasText:'current owner can edit'}).waitFor();
    assert.deepEqual((await read(get(api+queue,headers))).items,[]);
    await setCustom('none');
    await page.getByRole('button',{name:'Save new owner'}).click();
    await page.getByText('No matching records.').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('owner'),'unavailable');
    const {record}=await read(get(api+'?objectId='+objectId+'&record='+id,headers));
    assert.equal(record.data.recordOwner.userId,repId);
    assert.equal(record.revision,2);
    await setCustom('all');
    return peer;
  }finally{await browser.close();}
}
