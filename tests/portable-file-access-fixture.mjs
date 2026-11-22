import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CreateBucketCommand,PutObjectCommand} from '@aws-sdk/client-s3';

export async function verifyFileAccess({request,headers,other,origin,sql,fixture}){
  const get=(path,auth=headers,method='GET')=>request(path,{method,headers:auth});
  async function write(path,data){
    const response=await request(path,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(data)});
    assert.ok(response.ok,await response.clone().text());return response.json();
  }
  const {record}=await write('/api/crm',{action:'save',kind:'contacts',data:{name:'Harbor lighthouse crew'}});
  const sharing=await write('/api/workspaces',{action:'grant',email:'other@example.test'});
  const workspace=sharing.owned,contact=record.id,file=randomUUID(),v1=randomUUID(),v2=randomUUID();
  const member=sharing.viewers.find(person=>person.email==='other@example.test');
  const base='/api/record-attachments?recordId='+contact,download=base+'&fileId='+file,shared=download+'&workspaceId='+workspace;
  const history='/?'+new URLSearchParams({view:'record-access',action:'document',kind:'contacts',record:contact,file});
  const original='Fictional inventory, first edition',replacement='Fictional inventory, second edition';
  await fixture.storage.send(new CreateBucketCommand({Bucket:fixture.bucket}));
  async function upload(id,version,body,expected){
    const response=await request(base+'&'+new URLSearchParams({fileId:id,versionId:version,...(expected?{expectedVersion:expected}:{})}),
      {method:'POST',headers:{...headers,origin,'x-harbor-file-name':'Fictional%20inventory.txt'},body});
    assert.equal(response.status,200,await response.clone().text());
  }
  await upload(file,v1,original);await upload(file,v2,replacement,v1);
  const otherFile=randomUUID(),otherVersion=randomUUID();
  await upload(otherFile,otherVersion,'Another file on this contact');
  const receipts=()=>sql`SELECT actor_email,record_ids,file_version_id,file_revision FROM portable_record_access_events
    WHERE workspace_id=${workspace} AND file_id=${file} ORDER BY occurred_at,id`;
  const previews=()=>sql`SELECT record_ids FROM portable_record_access_events WHERE workspace_id=${workspace}
    AND kind='contacts' AND action='related' AND actor_email='owner@example.test' ORDER BY occurred_at,id`;
  const files='/?view=files',before=(await previews()).length;
  assert.equal((await get(files,headers,'HEAD')).status,200);
  assert.equal((await get(files+'&search=absent')).status,200);
  assert.equal((await previews()).length,before);
  assert.equal((await get(files+'&search=inventory')).status,200);
  assert.deepEqual((await previews()).slice(before),[{record_ids:[contact]}]);
  assert.equal((await get(shared,other)).status,404);
  assert.equal((await get(download+'&versionId='+randomUUID())).status,404);
  const head=await get(download,headers,'HEAD');
  assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.deepEqual([...(await receipts())],[]);
  assert.equal(await (await get(download)).text(),replacement);
  const granted=await write('/api/workspaces',{action:'contact_files',id:member.id,enabled:true});
  assert.equal(await (await get(shared+'&versionId='+v1,other)).text(),original);
  await write('/api/workspaces',{action:'contact_files',id:granted.viewers.find(row=>row.email==='other@example.test').id,enabled:false});
  assert.equal((await get(shared,other)).status,404);
  assert.deepEqual([...(await receipts())],[
    {actor_email:'owner@example.test',record_ids:[contact],file_version_id:v2,file_revision:2},
    {actor_email:'other@example.test',record_ids:[contact],file_version_id:v1,file_revision:1},
  ]);
  assert.equal(await (await get(base+'&fileId='+otherFile)).text(),'Another file on this contact');
  const allDownloads=await (await get(history.replace('&file='+file,''))).text();
  assert.ok(allDownloads.includes(otherVersion));
  const markup=await (await get(history)).text();
  assert.ok(!markup.includes(otherVersion));
  assert.ok(markup.includes(v1)&&markup.includes(v2)&&markup.includes('other@example.test'));
  assert.ok(!markup.includes(original)&&!markup.includes(replacement)&&!markup.includes('Fictional inventory.txt'));
  assert.match(await (await get(history,other)).text(),/No matching access events/);
  if(process.env.HARBOR_TEST_PLAYWRIGHT){
    const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
    const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
    try{
      const tab=await browser.newPage();
      const [name,value]=headers.cookie.split('=');
      await tab.context().addCookies([{name,value,url:origin}]);
      await tab.goto(origin+'/?contact='+contact);
      await tab.locator('a[href="'+history+'"]').click();
      const row=tab.getByRole('row').filter({hasText:'other@example.test'});
      await row.getByText('Contact file download · Version 1',{exact:true}).waitFor();
      await row.locator('summary').click();
      await row.getByText(v1,{exact:true}).waitFor();
      await tab.getByLabel('Actor email').fill('owner@example.test');
      await tab.getByRole('button',{name:'Apply filters'}).click();
      await tab.getByRole('row').filter({hasText:'owner@example.test'}).waitFor();
      assert.equal(await tab.getByRole('row').filter({hasText:'other@example.test'}).count(),0);
    }finally{await browser.close();}
  }
  // A failed history write or a bad object must release no bytes and record no download.
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT fixture_reject_download CHECK (file_id IS NULL) NOT VALID`;
  try{
    const denied=await get(download);assert.equal(denied.status,500);assert.ok(!(await denied.text()).includes(replacement));
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT fixture_reject_download`;}
  await fixture.storage.send(new PutObjectCommand({Bucket:fixture.bucket,Key:['contact-files',workspace,contact,file,v1].join('/'),Body:'Changed in storage'}));
  assert.equal((await get(download+'&versionId='+v1)).status,502);
  assert.equal((await receipts()).length,2);
}
