import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export async function verifyAircall({request,origin,headers,other,configure,env,sql}){
  const write=(path,body)=>request(path,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const response=await write('/api/crm',{action:'save',kind:'contacts',data:{name:'Fictional phone trial',phone:'+1 (202) 555-0136'}});
  assert.equal(response.status,201);
  const {record}=await response.json(),path='/?contact='+record.id;
  const disabled=await request(path,{headers});
  assert.equal(disabled.status,200);
  assert.ok(!(await disabled.text()).includes('Open Aircall dialer'));
  const hook='/api/aircall/events',token='fixture-aircall-notification-secret';
  const deliver=body=>request(hook,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const transcript={resource:'conversation_intelligence',event:'transcription.created',token,data:{id:720,call_id:'12',type:'call'}};
  const recording={resource:'call',event:'call.comm_assets_generated',token,data:{id:12,recording:'https://storage.example.test/fictional-signed-audio'}};
  assert.equal((await deliver(transcript)).status,404);
  const grant=async body=>{
    const result=await write('/api/workspaces',body);
    assert.ok(result.ok,await result.clone().text());
    return result.json();
  };
  const sharing=await grant({action:'grant',email:'other@example.test'});
  await configure({HARBOR_PORTABLE_AIRCALL_ENABLED:'true',HARBOR_AIRCALL_WORKSPACE_ID:sharing.owned,HARBOR_AIRCALL_WEBHOOK_TOKEN:token});
  assert.equal((await deliver({...transcript,token:'wrong'})).status,403);
  assert.equal((await deliver({...transcript,data:{call_id:'invalid',type:'call'}})).status,400);
  assert.equal((await deliver({...transcript,data:{call_id:'12',type:'voicemail'}})).status,200);
  assert.equal((await deliver({...recording,data:{id:12,recording:null}})).status,200);
  const receipts=()=>sql`SELECT * FROM portable_aircall_assets WHERE workspace_id=${sharing.owned} ORDER BY asset`;
  assert.equal((await receipts()).length,0);
  assert.deepEqual(await Promise.all([deliver(transcript),deliver(transcript)]).then(rs=>rs.map(r=>r.status)),[200,200]);
  assert.equal((await receipts()).length,1,'Keep availability even when the notification arrives before the rep logs the call.');
  const memberId=()=>sharingState.viewers.find(member=>member.email==='other@example.test').id;
  let sharingState=await grant({action:'contact_outreach',id:sharing.viewers[0].id,enabled:true});
  const memberPath=path+'&workspaceId='+sharing.owned;
  const sharedDialer=async()=>{
    const result=await request(memberPath,{headers:other});
    assert.equal(result.status,200);
    return (await result.text()).includes('Open Aircall dialer');
  };
  assert.equal(await sharedDialer(),false,'Viewers cannot place and log calls from the record');
  sharingState=await grant({action:'role',id:memberId(),role:'editor'});
  if(!sharingState.viewers[0].contactOutreach)sharingState=await grant({action:'contact_outreach',id:memberId(),enabled:true});
  assert.equal(await sharedDialer(),true,'An editor with contact outreach can use the dialer');
  sharingState=await grant({action:'contact_outreach',id:memberId(),enabled:false});
  assert.equal(await sharedDialer(),false,'Withdrawing outreach also removes the dialer');
  const saved=async()=> (await (await request('/api/logged-activities?contactId='+record.id,{headers})).json()).items;
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext({viewport:{width:375,height:812}});
    context.setDefaultTimeout(10000);
    const [name,value]=headers.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    let loads=0;
    // Use the real, packaged SDK. Answer its protocol inside an intercepted provider frame.
    await page.route('https://workspace.aircall.io/**',route=>{
      loads++;
      return route.fulfill({contentType:'text/html',body:`<script>
        const emit=(name,value)=>parent.postMessage({name:'apm_phone_'+name,value},${JSON.stringify(origin)});
        addEventListener('message',event=>{
          if(event.data.name==='apm_app_dial_number'){
            document.title=event.data.value.phone_number;
            emit('dial_number_response',{success:true});
          }
        });
        emit('loaded',{});
      </script>`});
    });
    await page.goto(origin+path);
    const open=page.getByRole('button',{name:'Open Aircall dialer'});
    await open.waitFor();
    assert.equal(loads,0);
    await open.click();
    const dial=page.getByRole('button',{name:'Dial +1 (202) 555-0136'});
    await dial.click();
    const frame=page.frames().find(f=>f.url().startsWith('https://workspace.aircall.io/'));
    assert.ok(frame);
    await frame.waitForFunction(()=>document.title==='+12025550136');
    const event=(name,value)=>frame.evaluate(([name,value])=>emit(name,value),[name,value]);
    const call=(id,to)=>event('outgoing_call',{call_id:id,to});
    const end=id=>event('call_ended',{call_id:id});
    const answer=id=>event('outgoing_answered',{call_id:id});
    await call(10,'+12025550137');await answer(10);await end(10);
    await call(11,'+12025550136');await end(11);
    await page.getByText('Call ended without a confirmed answer.').waitFor();
    const log=page.getByRole('button',{name:'Log answered call'});
    assert.equal(await log.count(),0);
    await call(12,'+12025550136');await answer(12);await end(12);await end(12);
    await log.waitFor();
    assert.deepEqual(await saved(),[]);
    await page.route('**/api/logged-activities?**',async route=>{
      if(route.request().method()!=='POST')return route.continue();
      assert.equal((await route.fetch()).status(),201);
      await route.abort(); // The database committed, but the rep did not see its response.
    });
    await log.click();
    await page.getByText(/Could not confirm the call was logged/).waitFor();
    await page.unroute('**/api/logged-activities?**');
    await log.click();
    await log.waitFor({state:'hidden'});
    assert.deepEqual((await saved()).map(item=>[item.kind,item.summary]),[['Call','Answered outbound Aircall call #12']]);
    // The provider's permanent page belongs to this call even after editing the summary.
    const [activity]=await saved();
    assert.equal(activity.id,'a17ca110-0000-8000-8000-00000000000c','Existing Aircall entries use this ID format');
    const activityPath='/api/logged-activities?contactId='+record.id;
    assert.equal((await write(activityPath,{action:'update',id:activity.id,expectedRevision:activity.revision,
      occurredAt:activity.occurredAt,summary:'Reviewed the renewal'})).status,200);
    assert.equal((await write(activityPath,{kind:'Call',id:crypto.randomUUID(),occurredAt:Date.now()-5000,
      summary:'Answered outbound Aircall call #999'})).status,201);
    assert.deepEqual(activity.aircallAssets,['transcript']);
    assert.equal((await deliver(recording)).status,200);
    assert.equal((await deliver({...recording,event:'call.ended'})).status,200);
    const assets=await receipts();
    assert.deepEqual(assets.map(row=>row.asset),['recording','transcript']);
    assert.deepEqual(Object.keys(assets[0]).sort(),['activity_id','asset','workspace_id']);
    const asset='https://assets.aircall.io/recording/12';
    let opens=0;
    // Exercise the browser handoff without contacting Aircall or a real recording.
    await context.route('https://assets.aircall.io/**',route=>{
      assert.equal(route.request().url(),asset);
      assert.equal(route.request().headers().referer,undefined);
      opens++;
      return route.fulfill({contentType:'text/html',body:'<title>Fictional Aircall asset</title>'});
    });
    await page.reload();
    const media=page.getByRole('link',{name:'Check recording and transcript in Aircall'});
    await media.waitFor();
    const availability='Aircall reported recording and transcript ready.';
    await page.getByText(availability,{exact:true}).waitFor();
    assert.equal(await media.count(),1);
    assert.equal(await media.getAttribute('href'),asset);
    assert.equal(opens,0);
    const [tab]=await Promise.all([context.waitForEvent('page'),media.click()]);
    await tab.waitForURL(asset);
    assert.equal(await tab.title(),'Fictional Aircall asset');
    await tab.close();
    assert.equal(opens,1);
    await page.goto(origin+'/?view=calls');
    await page.getByText('Reviewed the renewal',{exact:true}).waitFor();
    assert.equal(await media.count(),1);
    assert.equal(await media.getAttribute('href'),asset);
    await page.getByText(availability,{exact:true}).waitFor();
    const teamCalls='/?view=calls&workspaceId='+sharing.owned;
    sharingState=await grant({action:'contact_outreach',id:memberId(),enabled:true});
    assert.ok((await (await request(teamCalls,{headers:other})).text()).includes(asset));
    sharingState=await grant({action:'contact_outreach',id:memberId(),enabled:false});
    assert.ok(!(await (await request(teamCalls,{headers:other})).text()).includes(asset));
    const soloWrite=(path,body)=>request(path,{method:'POST',headers:{...other,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    const isolated=await soloWrite('/api/crm',{action:'save',kind:'contacts',data:{name:'Separate phone workspace'}});
    assert.equal(isolated.status,201);
    const {record:soloContact}=await isolated.json();
    const soloLog=await soloWrite('/api/logged-activities?contactId='+soloContact.id,{id:activity.id,kind:'Call',
      occurredAt:activity.occurredAt,summary:'Separate workspace call'});
    assert.equal(soloLog.status,201);
    const otherCalls=await request('/?view=calls',{headers:other});
    const soloHtml=await otherCalls.text();
    assert.ok(soloHtml.includes(asset)&&!soloHtml.includes(availability),'The same call ID in another workspace has no asset receipts.');

    const sequence=crypto.randomUUID(),enrollment=crypto.randomUUID();
    const command=async body=>{
      const result=await write('/api/sequences',body);
      assert.ok(result.ok,await result.clone().text());
      return result.json();
    };
    await command({action:'save',id:sequence,expectedRevision:0,name:'Fictional phone follow-up',
      steps:[{id:crypto.randomUUID(),type:'task',taskType:'Call',title:'Call about renewal',notes:'Confirm renewal timing.',delayDays:0}]});
    const [rep]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
    await command({action:'enroll',id:enrollment,sequenceId:sequence,expectedRevision:1,contactId:record.id,assigneeId:rep.id,recipient:null});
    const pass=()=>promisify(execFile)(process.execPath,['scripts/portable-web.mjs','worker','--once'],{
      env:{...env,HARBOR_SEQUENCE_WORKER_ENABLED:'true'},timeout:20000});
    const history=async()=> (await (await request('/api/sequences?enrollmentId='+enrollment,{headers})).json());
    await pass();
    const taskId=(await history()).steps[0].taskId;
    assert.ok(taskId);
    const taskPage='/?kind=tasks&record='+taskId+'&workspaceId='+sharing.owned;
    const detail=()=>request(taskPage,{headers:other}).then(r=>r.text());
    assert.ok(!(await detail()).includes('Open Aircall dialer'),'Outreach permission required on task');
    sharingState=await grant({action:'contact_outreach',id:memberId(),enabled:true});
    sharingState=await grant({action:'record_scope',id:memberId(),viewScope:'all',editScope:'owned'});
    assert.ok(!(await detail()).includes('Open Aircall dialer'),'An assigned task does not grant edit access to its contact');
    sharingState=await grant({action:'record_scope',id:memberId(),viewScope:'all',editScope:'all'});
    const [repCookie,repValue]=other.cookie.split('=');
    await context.addCookies([{name:repCookie,value:repValue,url:origin}]);
    await page.goto(origin+taskPage);
    await page.getByText('Log outreach and complete task',{exact:true}).click();
    await open.click();
    await dial.click();
    const taskFrame=page.frames().find(f=>f.url().startsWith('https://workspace.aircall.io/'));
    await taskFrame.waitForFunction(()=>document.title==='+12025550136');
    const emitCall=(name,id)=>taskFrame.evaluate(([name,id])=>emit(name,{call_id:id,to:'+12025550136'}),[name,id]);
    const finish=page.getByRole('button',{name:'Log answered call and complete task',exact:true});
    await emitCall('outgoing_call',13);await emitCall('call_ended',13);
    await page.getByText('Call ended without a confirmed answer.').waitFor();
    assert.equal(await finish.count(),0);
    const task=async()=> (await (await request('/api/crm?kind=tasks&id='+taskId,{headers})).json());
    assert.equal((await task()).completedAt,null);
    await emitCall('outgoing_call',14);await emitCall('outgoing_answered',14);await emitCall('call_ended',14);
    await page.getByLabel('What happened?').fill('Confirmed renewal timing.');
    await finish.waitFor();
    // An activity collision rolls the task write back. The same draft can be retried after a failed request.
    const crm='**/api/crm?**';
    await page.route(crm,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      const body=route.request().postDataJSON();
      body.outreach.aircall.callId=12;
      const res=await route.fetch({data:body});
      assert.equal(res.status(),409);
      await route.fulfill({response:res});
    });
    await finish.click();
    await page.getByRole('alert').filter({hasText:'Could not log outreach'}).waitFor();
    assert.equal((await task()).completedAt,null);
    await page.unroute(crm);
    const posted=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/crm'&&r.method()==='POST');
    await finish.click();
    const completion=await posted;
    await page.getByText('Outreach logged and task completed.',{exact:true}).waitFor();
    const completed=await task();
    assert.ok(completed.completedAt);
    const replay=await request(new URL(completion.url()).pathname+new URL(completion.url()).search,{method:'POST',
      headers:{...other,origin,'content-type':'application/json'},body:completion.postData()});
    assert.equal(replay.status,409);
    assert.equal((await task()).revision,completed.revision);
    await pass();
    assert.equal((await history()).enrollment.state,'completed');
    const receipt=(await saved()).filter(item=>item.summary==='Confirmed renewal timing.');
    assert.equal(receipt.length,1);
    assert.equal(receipt[0].id,'a17ca110-0000-8000-8000-00000000000e');
    await page.goto(origin+teamCalls);
    await page.getByText('Confirmed renewal timing.',{exact:true}).waitFor();
    assert.equal(await page.locator('a[href="https://assets.aircall.io/recording/14"]').count(),1);
  }finally{await browser.close();}
}
