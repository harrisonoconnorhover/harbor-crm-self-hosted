import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';

export async function verifyPortableEmailSuppression({request,origin,headers,other,sql,sharing}){
  const path='/api/email/suppressions',confirm='/api/email/unsubscribe';
  const ownerEmail='optout@example.test';
  const body={id:randomUUID(),email:'OPTOUT@example.test'};
  const get=(url,auth={})=>request(url,{headers:auth});
  const write=(url,auth,data,method='POST',site=origin)=>request(url,{method,headers:{
    ...auth,origin:site,'content-type':'application/json',
  },body:JSON.stringify(data)});
  const list=async auth=>await (await get(path,auth)).json();
  const remove=(auth,id)=>write(path,auth,{id},'DELETE');
  assert.equal((await get(path)).status,401);
  assert.equal((await get('/?view=email-settings')).status,307);
  assert.equal((await get('/?view=email-settings&workspaceId='+sharing.workspaceId,other)).status,404);
  const settings=await get('/?view=email-settings',headers);
  assert.equal(settings.status,200);
  assert.match(await settings.text(),/You can remove a manual block\. An address stays blocked if the recipient unsubscribed\./);
  assert.equal((await write(path,{},body)).status,401);
  assert.equal((await write(path,headers,body,'POST','https://outside.example.test')).status,403);

  const created=await write(path,headers,body);
  assert.equal(created.status,200);
  const blocked=await created.json();
  assert.equal(blocked.email,ownerEmail);
  assert.equal(blocked.recipientOptedOutAt,null);
  const duplicate=await write(path,headers,{id:randomUUID(),email:ownerEmail});
  assert.deepEqual(await duplicate.json(),blocked);
  assert.deepEqual(await list(other),{results:[],next:null,total:0});
  assert.equal((await remove(other,blocked.id)).status,200);
  assert.equal((await list(headers)).results[0].id,blocked.id);

  const otherBlock=await write(path,other,{id:randomUUID(),email:ownerEmail});
  assert.equal(otherBlock.status,200);
  const link=await write(path,headers,{action:'unsubscribeLink',email:'OPTOUT@example.test'});
  assert.equal(link.status,200);
  const {url}=await link.json();
  const parsed=new URL(url);
  assert.equal(parsed.origin,origin);
  assert.equal(parsed.pathname,'/email/unsubscribe');
  assert.equal(parsed.search,'');
  assert.ok(!url.includes(ownerEmail));
  const token=parsed.hash.slice(1);
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  const [stored]=await sql`SELECT token_hash,workspace_id,email FROM portable_email_unsubscribe_tokens WHERE email=${ownerEmail}`;
  assert.equal(stored.token_hash,createHash('sha256').update(token).digest('base64url'));
  assert.equal(stored.workspace_id,sharing.workspaceId);
  assert.equal(stored.email,ownerEmail);
  const landing=await get(parsed.pathname);
  assert.equal(landing.status,200);
  const html=await landing.text();
  assert.match(html,/Unsubscribe from email/);
  assert.doesNotMatch(html,/optout@example\.test/);
  assert.equal((await list(headers)).results[0].recipientOptedOutAt,null);
  assert.equal((await write(confirm,{},{token,email:ownerEmail})).status,400);
  assert.equal((await write(confirm,{},{token},'POST','https://outside.example.test')).status,403);
  assert.equal((await write(confirm,{},{token:'A'.repeat(43)})).status,404);

  const [clicked,deleted]=await Promise.all([write(confirm,{},{token}),remove(headers,blocked.id)]);
  assert.equal(clicked.status,200);
  assert.deepEqual(await clicked.json(),{unsubscribed:true});
  assert.match(clicked.headers.get('cache-control'),/no-store/);
  assert.ok([200,409].includes(deleted.status));
  const [confirmed]=(await list(headers)).results;
  assert.ok(confirmed.recipientOptedOutAt);
  assert.equal((await remove(headers,confirmed.id)).status,409);
  // A confirmed link stays responsive while the workspace write lock is held.
  await sql.begin(async tx=>{
    await tx`SELECT id FROM private_workspaces WHERE id=${sharing.workspaceId} FOR NO KEY UPDATE`;
    const replay=await request(confirm,{method:'POST',headers:{origin,'content-type':'application/json'},
      body:JSON.stringify({token}),signal:AbortSignal.timeout(5000)});
    assert.equal(replay.status,200);
    assert.deepEqual(await replay.json(),{unsubscribed:true});
  });
  assert.deepEqual((await list(headers)).results,[confirmed]);
  assert.equal((await list(other)).results[0].recipientOptedOutAt,null);
  assert.equal((await remove(other,(await otherBlock.json()).id)).status,200);
  assert.equal((await list(other)).total,0);
  assert.deepEqual((await list(headers)).results,[confirmed]);
  sharing.emailOptOut={record:confirmed,token};
}
