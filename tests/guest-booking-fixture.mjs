import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export function readGuestMail(options){
  const mime=Buffer.from(JSON.parse(options.body).raw,'base64url').toString('utf8');
  const [headers,encoded]=mime.split('\r\n\r\n');
  const address=/^To: ([^\r\n]+)/m.exec(headers)?.[1];
  const body=Buffer.from(encoded,'base64').toString('utf8');
  const code=/^([A-Za-z0-9_-]{43})\r?$/m.exec(body)?.[1];
  assert.ok(address&&code);
  return {address,code};
}

export async function verifyGuestBooking({post,mail,start,pageId,inspect,suppress,expire}){
  const email='guest-proof@example.test',requestId=randomUUID();
  const request={action:'request',requestId,email,start};
  assert.equal((await post(pageId,request,'https://outside.example.test')).status,403);
  assert.equal((await post(pageId,{...request,start:new Date(Date.parse(start)+60_000).toISOString()})).status,409);
  const claims=await Promise.all([post(pageId,request),post(pageId,request)]);
  for(const response of claims){
    assert.equal(response.status,202);
    assert.deepEqual(await response.json(),{accepted:true});
  }
  const deliveries=await mail();
  assert.equal(deliveries.length,1);
  assert.equal(deliveries[0].address,email);
  const {code}=deliveries[0];
  const verify={action:'verify',requestId,code};
  assert.equal((await post(pageId,{...verify,code:'a'.repeat(43)})).status,400);
  assert.equal((await post(randomUUID(),verify)).status,404);
  const responses=await Promise.all([post(pageId,verify),post(pageId,verify)]);
  for(const response of responses)assert.equal(response.status,200);
  const [statusProof,concurrentProof]=await Promise.all(responses.map(response=>response.json()));
  assert.equal(statusProof.verified,true);
  assert.match(statusProof.receipt,/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(concurrentProof,statusProof,'concurrent verification returns the same status receipt');
  const row=await inspect(requestId);
  assert.equal(row.delivery,'unknown');
  assert.notEqual(row.code_hash,code);
  assert.ok(Number(row.verified_at)>0);
  assert.equal(row.status_receipt,statusProof.receipt,'the accepted response matches the durable encrypted receipt');
  const replay=await post(pageId,verify);
  assert.equal(replay.status,200);
  assert.deepEqual(await replay.json(),statusProof,'retry after a lost response returns the original status receipt');
  assert.deepEqual(await inspect(requestId),row,'the retry leaves the verification timestamp and saved claim alone');
  assert.equal((await post(pageId,{...request,requestId:randomUUID()})).status,202);
  const blocked='no-proof@example.test';
  await suppress(blocked);
  const suppressedId=randomUUID();
  assert.equal((await post(pageId,{...request,requestId:suppressedId,email:blocked})).status,202);
  assert.equal(await inspect(suppressedId),undefined);
  assert.equal((await mail()).length,1);
  await expire(requestId);
  assert.equal((await post(pageId,verify)).status,400);
  return statusProof.receipt;
}

export async function verifyGuestStatusRead(post,receipt,start,end){
  const wrong=receipt.slice(0,-5)+(receipt.at(-5)==='a'?'b':'a')+receipt.slice(-4);
  assert.equal((await post(wrong)).status,404);
  const response=await post(receipt);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.equal(response.headers.has('set-cookie'),false);
  assert.deepEqual(await response.json(),{state:'pending',start,end});
}
