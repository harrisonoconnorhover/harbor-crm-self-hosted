import assert from 'node:assert/strict';
import test from 'node:test';
import {acceptReviewedWorkspaceInvitation,readWorkspaceAccess,saveWorkspaceAccess} from '../runtime/portable-invitation-acceptance.ts';

function mockDeadlines(t){
  const deadlines=[];
  t.mock.method(AbortSignal,'timeout',milliseconds=>{
    assert.equal(milliseconds,12_000);
    const deadline=new AbortController();
    deadlines.push(deadline);
    return deadline.signal;
  });
  return deadlines;
}

const timeout=new DOMException('Fictional workspace reply deadline','TimeoutError');
const stall=(signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));

test('an interrupted acceptance checks once for an accepted or still-pending invitation',async t=>{
  const deadlines=mockDeadlines(t);
  const invitation='fictional-invitation',workspace='fictional-workspace';
  for(const status of ['accepted','pending']){
    const calls=[];
    const accepting=acceptReviewedWorkspaceInvitation(async(path,init)=>{
      assert.equal(path,'/api/workspaces');
      assert.equal(init.signal,deadlines.at(-1).signal);
      calls.push(init.method??'GET');
      if(init.method==='POST'){
        assert.deepEqual(JSON.parse(init.body),{action:'accept_invite',id:invitation});
        if(status==='pending')return stall(init.signal);
        // Headers can arrive before a committed acceptance's reply body stalls.
        return new Response(new ReadableStream({
          start(stream){init.signal.addEventListener('abort',()=>stream.error(init.signal.reason),{once:true});},
        }));
      }
      assert.equal(init.cache,'no-store');
      assert.equal(init.signal.aborted,false);
      return Response.json(status==='accepted'?{shared:[{id:workspace}],incoming:[]}:
        {shared:[],incoming:[{id:invitation}]});
    },invitation,workspace,false);
    deadlines.at(-1).abort(timeout);
    assert.equal((await accepting).status,status);
    assert.deepEqual(calls,['POST','GET']);
  }
});

test('an unavailable invitation only succeeds if the reviewed workspace is already shared',async()=>{
  const invitation='fictional-invitation',workspace='fictional-workspace';
  const message='This invitation is unavailable.';
  for(const sharing of [
    {shared:[{id:workspace}]},
    {shared:[{id:'other-workspace'}],incoming:[{id:invitation}]},
    null,
  ]){
    const calls=[];
    const result=await acceptReviewedWorkspaceInvitation(async(path,init)=>{
      assert.equal(path,'/api/workspaces');
      calls.push(init.method??'GET');
      if(init.method==='POST'){
        assert.deepEqual(JSON.parse(init.body),{action:'accept_invite',id:invitation});
        return Response.json({error:message},{status:404});
      }
      assert.equal(init.cache,'no-store');
      return sharing?Response.json(sharing):Response.json({error:'Unavailable'},{status:503});
    },invitation,workspace,false);
    assert.deepEqual(result,sharing?.shared[0].id===workspace?{status:'accepted'}:{status:'denied',message});
    assert.deepEqual(calls,['POST','GET']);
  }
});

test('other acceptance denials keep their original result without a follow-up read',async()=>{
  const message='Workspace access was denied.';
  const calls=[];
  const result=await acceptReviewedWorkspaceInvitation(async(path,init)=>{
    assert.equal(path,'/api/workspaces');
    calls.push(init.method??'GET');
    return Response.json({error:message},{status:403});
  },'fictional-invitation','fictional-workspace',false);
  assert.deepEqual(result,{status:'denied',message});
  assert.deepEqual(calls,['POST']);
});

test('a workspace change with stalled write and read replies stays unconfirmed',async t=>{
  const deadlines=mockDeadlines(t),calls=[];
  const saving=saveWorkspaceAccess(async(path,init)=>{
    calls.push(init.method??'GET');
    const deadline=deadlines.at(-1);
    assert.equal(init.signal,deadline.signal);
    queueMicrotask(()=>deadline.abort(timeout));
    return stall(init.signal);
  },{action:'invite',email:'fictional@example.test',role:'viewer'});
  assert.deepEqual(await saving,{status:'unconfirmed'});
  assert.deepEqual(calls,['POST','GET']);
});

test('initial workspace reads stop at their own deadline or when the view closes',async t=>{
  const deadlines=mockDeadlines(t);
  const read=()=>readWorkspaceAccess((path,init)=>stall(init.signal),view.signal);
  const view=new AbortController();
  const loading=read();
  deadlines[0].abort(timeout);
  await assert.rejects(loading,{name:'TimeoutError'});
  assert.equal(view.signal.aborted,false);
  const leaving=read();
  view.abort();
  await assert.rejects(leaving,{name:'AbortError'});
  assert.equal(deadlines[1].signal.aborted,false);
});

test('acceptance confirms a workspace outside the account overview without repeating the write',async()=>{
  for(const [code,expected] of [[200,'accepted'],[404,'denied'],[503,'unconfirmed']]){
    const methods=[];
    const result=await acceptReviewedWorkspaceInvitation(async(path,init)=>{
      methods.push(init.method??'GET');
      if(init.method==='POST')return Response.json({shared:[{id:'another'}],sharedNext:'more'});
      assert.equal(path,'/api/workspaces?joined=1&current=reviewed');
      return Response.json({current:{id:'reviewed'}},{status:code});
    },'invite','reviewed',false);
    assert.equal(result.status,expected);
    assert.deepEqual(methods,['POST','GET']);
  }
});
