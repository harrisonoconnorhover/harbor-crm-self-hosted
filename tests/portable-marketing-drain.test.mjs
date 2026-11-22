import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as wait} from 'node:timers/promises';
import {runMarketingDrain} from '../runtime/portable-marketing-drain.mjs';

const defaults={limit:10,concurrency:3,rate:1000,durationMs:5000};

test('paced starts wait for capacity, count outcomes and finish every in-flight pass at the limit',async()=>{
  const starts=[],first=Promise.withResolvers(),second=Promise.withResolvers();
  let active=0,peak=0;
  const running=runMarketingDrain({...defaults,limit:4,concurrency:2,rate:80,pass:async()=>{
    const index=starts.push(performance.now());
    peak=Math.max(peak,++active);
    if(index===2)second.resolve();
    if(index<=2)await first.promise;
    active--;
    return index%2?'skipped':'accepted';
  }});
  await second.promise;
  await wait(40);
  assert.equal(starts.length,2);
  first.resolve();
  const result=await running;
  assert.equal(peak,2);
  assert.equal(active,0);
  assert.equal(result.started,4);
  assert.equal(result.stoppedBy,'limit');
  assert.deepEqual(result.counts,{skipped:2,accepted:2});
  for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=12,JSON.stringify(starts));
});

test('dispatch-aware pacing spaces actual sends despite slow claims and variable receipt times',async()=>{
  const starts=[],sends=[],receipts=[],lastSend=Promise.withResolvers();
  let skippedAt;
  const result=await runMarketingDrain({...defaults,limit:5,concurrency:3,rate:80,paceDispatch:true,pass:async notify=>{
    const index=starts.push(performance.now());
    if(index===1||index===3)await wait(40);
    if(index===3){skippedAt=performance.now();return 'skipped';}
    sends.push(performance.now());
    notify();
    if(index===1)await lastSend.promise;
    if(index===5)lastSend.resolve();
    receipts.push(index);
    return 'accepted';
  }});
  assert.equal(result.stoppedBy,'limit');
  assert.deepEqual(result.counts,{accepted:4,skipped:1});
  assert.deepEqual(receipts,[2,4,5,1]);
  assert.ok(starts[1]-sends[0]>=12);
  assert.ok(starts[3]-skippedAt>=12,'A skipped claim also releases the gate after it settles.');
  for(let i=1;i<sends.length;i++)assert.ok(sends[i]-sends[i-1]>=12,JSON.stringify(sends));
});

test('provider feedback recorded during a send counts its saved outcome and continues the batch',async()=>{
  const outcomes=['delivered','suppressed','bounced','complained'];
  let i=0;
  const result=await runMarketingDrain({...defaults,limit:outcomes.length,pass:async()=>outcomes[i++]});
  assert.deepEqual(result.counts,{delivered:1,suppressed:1,bounced:1,complained:1});
  assert.equal(result.stoppedBy,'limit');
});

test('all terminal states halt new work and include already-started receipts',async()=>{
  for(const state of ['idle','disabled','waiting_for_sync','uncertain','failed','retry','throttled']){
    const first=Promise.withResolvers(),stopping=Promise.withResolvers();
    let calls=0;
    const running=runMarketingDrain({...defaults,pass:async()=>{
      if(++calls===1)return first.promise;
      stopping.resolve();
      return state;
    }});
    await stopping.promise;
    await wait(4);
    assert.equal(calls,2);
    first.resolve('accepted');
    const result=await running;
    assert.deepEqual(result.counts,{[state]:1,accepted:1});
    assert.equal(result.stoppedBy,state);
  }
});

test('duration and abort stop new passes while preserving completed outcomes',async()=>{
  const timed=await runMarketingDrain({...defaults,rate:1,durationMs:20,pass:async()=>'accepted'});
  assert.equal(timed.stoppedBy,'duration');
  assert.equal(timed.started,1);
  const controller=new AbortController(),release=Promise.withResolvers();
  const running=runMarketingDrain({...defaults,signal:controller.signal,pass:async()=>release.promise});
  controller.abort();
  release.resolve('accepted');
  const aborted=await running;
  assert.deepEqual(aborted.counts,{accepted:1});
  assert.equal(aborted.stoppedBy,'signal');
  const preaborted=await runMarketingDrain({...defaults,signal:controller.signal,pass:async()=>assert.fail('Aborted')});
  assert.equal(preaborted.started,0);
  assert.equal(preaborted.stoppedBy,'signal');
});

test('unexpected errors stop new claims and surface after pending passes settle',async()=>{
  const release=Promise.withResolvers(),attempted=Promise.withResolvers();
  let calls=0,settled=false;
  const error=Error('Fictional claim error');
  const running=runMarketingDrain({...defaults,pass:async()=>{
    if(++calls===1){await release.promise;return 'accepted';}
    attempted.resolve();throw error;
  }});
  const checked=assert.rejects(running,e=>e===error).then(()=>{settled=true;});
  await attempted.promise;
  await wait(4);
  assert.equal(settled,false);
  assert.equal(calls,2);
  release.resolve();
  await checked;
  await assert.rejects(runMarketingDrain({...defaults,pass:async()=>'typo'}),/Unexpected marketing pass outcome/);
});

test('invalid execution bounds fail before starting any pass',async()=>{
  for(const options of [{limit:0},{durationMs:Infinity},{rate:NaN},{concurrency:1.5}]){
    await assert.rejects(runMarketingDrain({...defaults,...options,pass:async()=>assert.fail('Invalid bounds')}),RangeError);
  }
});
