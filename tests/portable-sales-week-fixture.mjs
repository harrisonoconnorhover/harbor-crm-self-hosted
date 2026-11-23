import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {CreateBucketCommand,DeleteObjectCommand,ListObjectsV2Command} from '@aws-sdk/client-s3';
import {localFileFixture} from './portable-files-fixture.mjs';

async function checked(response){
  assert.ok(response.ok,response.status+' '+(await response.clone().text()).slice(0,300));
  return response;
}

export async function verifySalesWeek({env,mock,request,origin,headers,other,signIn,fixture,directory}){
  const post=(path,body,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const write=async(path,body,auth)=>(await checked(await post(path,body,auth))).json();
  const read=async(path,auth)=>(await checked(await request(path,{headers:auth}))).json();
  const north='North Pier Coffee',south='Sundial Roasters';
  const csv='Company Name,Company Domain\n'+north+',north-pier.example.test\n'+south+',sundial.example.test';
  const preview=await write('/api/crm/import',{action:'preview',kind:'companies',csv});
  assert.equal(preview.created,2);
  assert.equal((await write('/api/crm/import',{action:'import',kind:'companies',csv,review:preview.review,requestId:randomUUID()})).created,2);
  const company=async name=>(await read('/api/crm?kind=companies&search='+encodeURIComponent(name),headers)).records[0];
  const pier=await company(north),sundial=await company(south);
  assert.equal(pier.data.name,north);assert.equal(sundial.data.name,south);
  const {record:buyer}=await write('/api/crm',{action:'save',kind:'contacts',primaryCompanyId:pier.id,data:{name:'Avery Linden',email:'avery@north-pier.example.test'}});
  const onboard=async(email,auth)=>{
    const invited=await write('/api/workspaces',{action:'invite',email,role:'editor'});
    const invitation=invited.sent.find(v=>v.email===email);
    await write('/api/workspaces',{action:'accept_invite',id:invitation.id},auth);
    const directory=await read('/api/workspaces',headers);
    const member=directory.viewers.find(v=>v.email===email);
    assert.equal(member.role,'editor');
    const shared=await write('/api/workspaces',{action:'contact_files',id:member.id,enabled:true});
    const grant=shared.viewers.find(v=>v.email===email);
    return {auth,workspace:shared.owned,grant:grant.id,crm:'/api/crm?'+new URLSearchParams({workspaceId:shared.owned,grantId:grant.id})};
  };
  const alex=await onboard('other@example.test',other);
  const sam=await onboard('invitee@example.test',await signIn('invitee@example.test'));
  console.log('Monday: imported North Pier Coffee and Sundial Roasters, linked Avery to North Pier, and accepted both editor invitations.');

  const deal=async(rep,name,companyId,amount)=>(await write(rep.crm,{action:'save',kind:'deals',companyId,
    data:{name,amount,stage:'Qualified to buy',closeDate:'2031-04-25'}},rep.auth)).record;
  const sale=await deal(alex,'North Pier spring order',pier.id,12000);
  const open=await deal(sam,'Sundial service renewal',sundial.id,8000);
  const sharedDeal='/api/crm?kind=deals&id='+sale.id+'&workspaceId='+sam.workspace;
  const reviewed=await read(sharedDeal,sam.auth);
  assert.equal(reviewed.revision,sale.revision);
  const change={action:'save',kind:'deals',id:sale.id,expectedRevision:sale.revision,data:{name:sale.data.name,stage:'Closed won',amount:12000}};
  await write(alex.crm,change,alex.auth);
  assert.equal((await post(sam.crm,{...change,data:{name:sale.data.name,amount:9000}},sam.auth)).status,409);
  const won=await read(sharedDeal,sam.auth);
  assert.equal(won.stageName,'Closed won');assert.equal(won.data.amount,12000);
  console.log('Tuesday: Alex and Sam worked the same pipeline. A stale edit was rejected; Sam reopened the $12,000 won deal. The $8,000 renewal remained open.');

  await fixture.storage.send(new CreateBucketCommand({Bucket:fixture.bucket}));
  const fileId=randomUUID(),versionId=randomUUID(),file='/api/record-attachments?'+new URLSearchParams({recordId:buyer.id,fileId,versionId});
  const bytes=Buffer.from('North Pier Coffee — accepted spring order — USD 12,000.\n');
  await checked(await request(file,{method:'POST',headers:{...headers,origin,'x-harbor-file-name':'spring-order.txt'},body:bytes}));
  const sharedFile=file+'&workspaceId='+alex.workspace;
  const fetchBytes=async(send,path,auth)=>Buffer.from(await (await checked(await send(path,{headers:auth}))).arrayBuffer());
  assert.deepEqual(await fetchBytes(request,sharedFile,alex.auth),bytes);
  assert.deepEqual(await fetchBytes(request,sharedFile,sam.auth),bytes);
  const taskName='Confirm North Pier delivery';
  const {record:task}=await write(alex.crm,{action:'save',kind:'tasks',related:{kind:'deals',id:sale.id},
    data:{name:taskName,dueDate:'2031-04-24'}},alex.auth);
  await write(sam.crm,{action:'save',kind:'tasks',id:task.id,expectedRevision:task.revision,
    data:{name:taskName,status:'Completed'}},sam.auth);
  const history=await read('/api/crm?kind=tasks&recordKind=deals&completionHistoryFor='+sale.id,headers);
  assert.equal(history.items[0].id,task.id);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage();
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=forecast&month=2031-04');
    const card=label=>page.locator('.forecast-cards div').filter({has:page.getByText(label,{exact:true})}).locator('dd');
    assert.equal(await card('Closed won').innerText(),'12,000.00');
    assert.equal(await card('Forecast including closed won').innerText(),'15,200.00');
  }finally{await browser.close();}
  console.log('Wednesday: the manager opened Forecast in Chrome. $12,000 won plus 40% of the $8,000 renewal gave $15,200. Sam completed Alex’s linked delivery task; it appeared on the deal history. Both reps opened the private order attachment.');

  await write('/api/workspaces',{action:'revoke',id:alex.grant});
  assert.equal((await request(sharedDeal,{headers:alex.auth})).status,404);
  assert.equal((await request(sharedFile,{headers:alex.auth})).status,404);
  assert.equal((await post(alex.crm,{...change,expectedRevision:won.revision},alex.auth)).status,403);
  assert.deepEqual(await fetchBytes(request,sharedFile,sam.auth),bytes);
  assert.equal((await read('/api/crm?kind=deals&id='+open.id+'&workspaceId='+sam.workspace,sam.auth)).data.amount,8000);
  console.log('Thursday: offboarded Alex. The existing session lost its record, write and file access. Sam retained the open renewal and attachment.');

  const target=new URL(process.env.HARBOR_TEST_RESTORE_POSTGRES_URL);
  assert.equal(target.hostname,'127.0.0.1');assert.notEqual(target.port,new URL(env.DATABASE_URL).port);
  const replacement=localFileFixture(process.env.HARBOR_TEST_RESTORE_S3_ENDPOINT);
  assert.notEqual(replacement.env.HARBOR_S3_ENDPOINT,fixture.env.HARBOR_S3_ENDPOINT);
  await replacement.storage.send(new CreateBucketCommand({Bucket:replacement.bucket}));
  const bundle=join(directory,'sales-week-backup'),command='scripts/portable-web.mjs';
  const run=(configuration,...args)=>execFileSync(process.execPath,[command,...args],{env:configuration,encoding:'utf8',timeout:60000});
  assert.match(run(env,'backup',bundle),/Verified file versions: 1/);
  const objects=await fixture.storage.send(new ListObjectsV2Command({Bucket:fixture.bucket}));
  assert.equal(objects.KeyCount,1);
  await fixture.storage.send(new DeleteObjectCommand({Bucket:fixture.bucket,Key:objects.Contents[0].Key}));
  assert.equal((await request(file,{headers})).ok,false);
  const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const restoredOrigin='http://127.0.0.1:'+port;
  const config={...env,...replacement.env,DATABASE_URL:target.href,PORT:String(port),HARBOR_LOGIN_ORIGIN:restoredOrigin};
  assert.match(run(config,'restore',bundle),/Verified file versions: 1/);
  const server=spawn(process.execPath,['--import',mock,command,'start'],{env:config,stdio:['ignore','ignore','inherit']});
  const exited=once(server,'exit');
  const recovered=(path,options={})=>fetch(restoredOrigin+path,{redirect:'manual',signal:AbortSignal.timeout(3000),...options});
  try{
    let ready=false;
    for(let i=0;i<100&&server.exitCode===null&&!ready;i++){
      ready=(await recovered('/healthz').catch(()=>null))?.status===200;
      if(!ready)await delay(100);
    }
    assert.ok(ready);
    const recoveredOwner=await signIn('owner@example.test',recovered,restoredOrigin);
    const saved=(await (await checked(await recovered('/api/crm?kind=contacts&id='+buyer.id,{headers:recoveredOwner}))).json());
    assert.equal(saved.primaryCompanyId,pier.id);
    const restoredBytes=await fetchBytes(recovered,file,recoveredOwner);
    assert.deepEqual(restoredBytes,bytes);
    const recoveredAlex=await signIn('other@example.test',recovered,restoredOrigin);
    assert.equal((await recovered(sharedFile,{headers:recoveredAlex})).status,404);
    console.log('Friday: removed the order file from the fictional source bucket and confirmed download failed. Restored the database and files to a second instance. Fresh sign-in recovered Avery’s company link and the exact attachment. SHA-256 '+createHash('sha256').update(restoredBytes).digest('hex'));
  }finally{server.kill();await exited;replacement.storage.destroy();}
}
