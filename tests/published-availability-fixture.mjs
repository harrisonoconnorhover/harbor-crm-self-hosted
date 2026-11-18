import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPublishedAvailability({request,owner,other,origin,hold,providerCalls}){
  const endpoint='/api/calendar/availability-page';
  const send=(body,headers=owner,site=origin)=>request(endpoint,{method:'POST',
    headers:{...headers,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const times=(start,end)=>({start:new Date(start).toISOString(),end:new Date(end).toISOString()});
  const now=Date.now(),first=times(now+3_600_000,now+5_400_000),second=times(now+7_200_000,now+9_000_000);
  const payload={action:'publish',id:randomUUID(),previousId:null,title:'Fictional team availability',timeZone:'UTC',slots:[second,first]};
  const url='/availability/'+payload.id;
  const before=await providerCalls?.();
  const read=async(path,status)=>{
    const response=await request(path);
    assert.equal(response.status,status,path);
    assert.match(response.headers.get('cache-control'),/no-store/);
    assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    assert.equal(response.headers.has('set-cookie'),false);
    return await response.text();
  };
  assert.equal((await request(endpoint)).status,401);
  assert.equal((await send(payload,owner,'https://outside.example.test')).status,403);
  assert.equal((await send(payload,{})).status,401);
  await read(url,404);
  for(const slots of [[first,first],[times(now,now+1000)],[times(now+15*86_400_000,now+15*86_400_000+3_600_000)]]){
    assert.equal((await send({...payload,slots})).status,400);
  }
  const initial=await send(payload);
  assert.equal(initial.status,200);
  const saved=await initial.json();
  assert.deepEqual(saved,{enabled:true,revision:payload.id,page:{id:payload.id,title:payload.title,timeZone:'UTC',slots:[first,second],allowGuestProof:false}});
  assert.deepEqual(await (await send(payload)).json(),saved);
  const foreign=await request(endpoint,{headers:other});
  assert.ok([200,403].includes(foreign.status));
  assert.doesNotMatch(await foreign.text(),new RegExp(payload.id));
  assert.ok([200,403].includes((await send({action:'unpublish',id:payload.id},other)).status));
  assert.deepEqual(await (await request(endpoint,{headers:owner})).json(),saved);
  const open=await read(url,200);
  assert.match(open,/Fictional team availability/);
  assert.match(open,/Contact the organizer to confirm a time/);
  assert.doesNotMatch(open,/owner@example\.test|fixture-calendar-refresh|private-event-title/);
  assert.ok(open.includes(first.start)&&open.includes(second.start));
  const head=await request(url,{method:'HEAD'});
  assert.equal(head.status,200);
  assert.match(head.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  await hold(first);
  const held=await read(url,200);
  assert.ok(!held.includes(first.start)&&held.includes(second.start));
  assert.equal((await send({...payload,id:randomUUID(),previousId:payload.id})).status,409);
  const candidates=[0,1].map(()=>({...payload,id:randomUUID(),previousId:payload.id,slots:[second]}));
  const outcomes=await Promise.all(candidates.map(candidate=>send(candidate)));
  assert.deepEqual(outcomes.map(response=>response.status).sort(),[200,409]);
  const replacement=candidates[outcomes.findIndex(response=>response.ok)];
  await read('/availability/'+candidates.find(candidate=>candidate!==replacement).id,404);
  await read(url,404);
  const next='/availability/'+replacement.id;
  await read(next,200);
  const revoke={action:'unpublish',id:replacement.id};
  const revoked=await (await send(revoke)).json();
  assert.equal(revoked.page,null);
  assert.ok(revoked.revision&&revoked.revision!==replacement.id);
  assert.deepEqual(await (await send(revoke)).json(),revoked);
  await read(next,404);
  assert.equal((await send(payload)).status,409);
  assert.equal((await send(replacement)).status,409);
  const final={...replacement,id:randomUUID(),previousId:revoked.revision};
  assert.equal((await send(final)).status,200);
  await read('/availability/'+final.id,200);
  if(providerCalls)assert.deepEqual(await providerCalls(),before,'sharing and public reads never contact Google');
  return final.id;
}
