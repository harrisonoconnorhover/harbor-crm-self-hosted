import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import {journeyScript} from '../lib/portable-journey-script.ts';
import {acceptFormJourney} from '../lib/portable-form-journey.ts';

const site=randomUUID(),form=randomUUID(),host='https://shop.example',harbor='https://harbor.example';
const formURL=harbor+'/forms/'+form;
function storage(){
  const values=new Map();
  return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values};
}
function target(){
  const handlers=new Map();
  return {addEventListener:(e,fn)=>handlers.set(e,fn),removeEventListener:(e,fn)=>{if(handlers.get(e)===fn)handlers.delete(e);},
    dispatchEvent:event=>handlers.get(event.type)?.(event)};
}
function frame(url){
  const posts=[];
  return {src:url,posts,contentWindow:{postMessage:(data,origin)=>posts.push({data,origin})}};
}
function install(shared=storage(),gpc=false,landing=false,siteId=site){
  const window=target(),sessionStorage=storage(),frames=[],requests=[],timers=[];
  const button=target(),status={},panel={hidden:true,querySelector:key=>key==='[data-journey-toggle]'?button:status};
  const document={...target(),querySelector:()=>panel,currentScript:{src:harbor+'/journey.js',dataset:{site:siteId,paths:'/pricing,/demo',landingConsent:String(landing)}},
    referrer:'',querySelectorAll:()=>frames};
  const location=new URL(host+'/pricing?utm_source=search&utm_campaign=spring-launch&email=private@example.test#hidden');
  const navigator={globalPrivacyControl:gpc};
  vm.runInNewContext(journeyScript,{window,document,location,navigator,localStorage:shared,sessionStorage,crypto:{randomUUID},URL,Event,
    fetch:async(url,init)=>{requests.push({url,init,body:JSON.parse(init.body)});return {ok:true};},
    setTimeout:fn=>timers.push(fn)});
  return {api:window.HarborJourney,requests,window,document,location,shared,sessionStorage,navigator,frames,timers,button,status,panel};
}

test('Loading stays passive; opt-in tracks public paths and campaign codes without URL parameters or private paths',async()=>{
  const a=install();
  assert.equal(a.requests.length,0);assert.equal(a.shared.values.size,0);
  await a.api.start();await a.api.start();
  const [first]=a.requests;assert.equal(a.requests.length,1);
  assert.equal(first.url,harbor+'/api/public/journey?siteId='+site);
  assert.equal(first.init.credentials,'omit');assert.equal(first.init.referrerPolicy,'no-referrer');assert.ok(first.init.keepalive);
  assert.equal(first.body.path,'/pricing');assert.equal(first.body.source,'search');assert.equal(first.body.campaign,'spring-launch');
  assert.ok(!JSON.stringify(first).includes('private@example'));assert.ok(!JSON.stringify(first).includes('hidden'));
  a.location.href=host+'/customer/jane-doe?access_token=secret';await a.api.page();
  assert.equal(a.requests[1].body.path,'/other');assert.equal(a.requests[1].body.source,'search');
  assert.notEqual(first.body.eventId,a.requests[1].body.eventId);
  const next=install(a.shared);await next.api.start();assert.equal(next.requests[0].body.visitor,first.body.visitor);
  const [key]=a.shared.values.keys();a.shared.setItem(key,JSON.stringify({visitor:first.body.visitor,until:Date.now()-1}));
  const later=install(a.shared);await later.api.start();assert.notEqual(later.requests[0].body.visitor,first.body.visitor);
  a.api.stop();await a.api.page();assert.equal(a.requests.length,2);assert.equal(a.shared.values.size,0);assert.equal(a.sessionStorage.values.size,0);
  const blocked=install(undefined,true);await blocked.api.start();assert.equal(blocked.requests.length,0);assert.equal(blocked.shared.values.size,0);
});
test('Published landing consent lasts for one registered site and can be withdrawn without disabling the form',async()=>{
  const shared=storage(),first=install(shared,false,true);
  assert.equal(first.panel.hidden,false);assert.equal(first.button.textContent,'Allow visit measurement');assert.equal(first.requests.length,0);
  first.button.dispatchEvent({type:'click'});assert.equal(first.requests.length,1);assert.equal(first.button.textContent,'Stop visit measurement');
  const second=install(shared,false,true);assert.equal(second.requests.length,1);assert.equal(second.requests[0].body.visitor,first.requests[0].body.visitor);
  const neighbor=install(shared,false,true,randomUUID());assert.equal(neighbor.requests.length,0);
  second.button.dispatchEvent({type:'click'});assert.equal(second.button.textContent,'Allow visit measurement');assert.equal(shared.values.size,0);
  const blocked=install(shared,true,true);assert.equal(blocked.button.hidden,true);assert.match(blocked.status.textContent,/Global Privacy Control/);assert.equal(blocked.requests.length,0);
});
test('Invalid campaign codes are dropped, off-site referrers contribute only a hostname',async()=>{
  const a=install();a.location.search='?utm_source=user%40example.com&utm_campaign=%3Cscript%3E';
  a.document.referrer='https://search.example/person/confidential?ticket=private#token';
  await a.api.start();assert.equal(a.requests[0].body.source,'search.example');assert.equal(a.requests[0].body.medium,'referral');
  assert.equal(a.requests[0].body.campaign,undefined);assert.ok(!JSON.stringify(a.requests).includes('confidential'));
});
test('Only Harbor form links and matching frame windows receive the consented visitor key; withdrawal clears frames',async()=>{
  const a=install(),approved=frame(formURL),foreign=frame('https://else.example/forms/'+form);
  a.frames.push(approved,foreign);await a.api.start();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(approved.posts[0].origin,harbor);assert.equal(approved.posts[0].data.journey.visitor,a.requests[0].body.visitor);
  assert.equal(foreign.posts.length,0);approved.posts.length=0;
  const request={type:'message',origin:harbor,source:approved.contentWindow,data:{type:'harbor:journey-request',formId:form}};
  a.window.dispatchEvent({...request,origin:host});a.window.dispatchEvent({...request,source:foreign.contentWindow});
  a.window.dispatchEvent({...request,data:{...request.data,formId:randomUUID()}});await new Promise(resolve=>setImmediate(resolve));assert.equal(approved.posts.length,0);
  a.window.dispatchEvent(request);await new Promise(resolve=>setImmediate(resolve));assert.equal(approved.posts.length,1);
  const click=href=>{const link={href};a.document.dispatchEvent({type:'click',target:{closest:()=>link}});return link;};
  const canonical=click(formURL);assert.equal(new URL(canonical.href).hash,'#harbor-journey='+site+'.'+a.requests[0].body.visitor);
  for(const other of [host+'/forms/'+form,harbor+'/account',harbor+'/forms/'+form+'/extra',formURL+'#other'])assert.equal(click(other).href,other);
  a.timers.forEach(fn=>fn());assert.equal(canonical.href,formURL);
  a.api.stop();assert.equal(approved.posts.at(-1).data.journey,null);assert.equal(click(formURL).href,formURL);
});
test('Form receives only the approved parent and correct form id. Top-level links consume the fragment on arrival.',t=>{
  const visitor=randomUUID(),values=[],requests=[],w=target(),parent={postMessage:(m,to)=>requests.push({m,to})};
  const original=new Map();
  function bind(key,value){
    if(!original.has(key))original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  t.after(()=>{for(const [k,v] of original){if(v)Object.defineProperty(globalThis,k,v);else Reflect.deleteProperty(globalThis,k);}});
  bind('window',Object.assign(w,{parent}));bind('navigator',{globalPrivacyControl:false});
  const off=acceptFormJourney(form,host,v=>values.push(v));
  assert.equal(requests[0].to,host);
  const event={type:'message',source:parent,origin:host,data:{type:'harbor:journey',formId:form,journey:{siteId:site,visitor}}};
  w.dispatchEvent({...event,source:{}});w.dispatchEvent({...event,origin:'https://unrelated.example'});
  w.dispatchEvent({...event,data:{...event.data,formId:randomUUID()}});assert.deepEqual(values,[]);
  w.dispatchEvent(event);assert.deepEqual(values,[{siteId:site,visitor}]);
  w.dispatchEvent({...event,data:{...event.data,journey:null}});assert.equal(values.at(-1),null);off();
  const rewrites=[];w.parent=w;bind('location',new URL(formURL+'?locale=en#harbor-journey='+site+'.'+visitor));
  bind('history',{state:{},replaceState:(_s,_t,path)=>rewrites.push(path)});
  acceptFormJourney(form,undefined,v=>values.push(v));assert.deepEqual(values.at(-1),{siteId:site,visitor});assert.deepEqual(rewrites,['/forms/'+form+'?locale=en']);
  bind('navigator',{globalPrivacyControl:true});acceptFormJourney(form,undefined,v=>values.push(v));assert.equal(values.at(-1),null);
});
