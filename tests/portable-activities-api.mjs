import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';

const source=process.env.TRANSFER_SOURCE_URL,destination=process.env.TRANSFER_DESTINATION_URL;
for(const url of [source,destination])if(!url||!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('Two disposable local Workers are required.');
assert.notEqual(source,destination);
const dir=process.env.TRANSFER_PROOF_DIR||'.harbor/portable-activities',actor='portable-activities-'+randomUUID(),browserActor=actor+'-browser',author='Fictional history author';let checks=0;
mkdirSync(dir,{recursive:true});
const check=(value,label)=>{assert.ok(value,label);checks++;};
async function request(url,path,body,user=actor){
 const r=await fetch(url+path,{method:body?'POST':'GET',headers:{origin:url,'content-type':'application/json','oai-authenticated-user-id':user,'oai-authenticated-user-email':user+'@example.test','oai-authenticated-user-full-name':encodeURIComponent(author),'oai-authenticated-user-full-name-encoding':'percent-encoded-utf-8'},...(body?{body:JSON.stringify(body)}:{})});
 return {status:r.status,data:await r.json()};
}
const crm=(url,body,user)=>request(url,'/api/crm',body,user),transfer=(url,body,user)=>request(url,'/api/record-transfers',body,user);
async function settings(url,user,change){const current=await request(url,'/api/activity-options',undefined,user);check(current.status===200,'read fictional activity settings');const saved=await request(url,'/api/activity-options',change(current.data.settings),user);check(saved.status===200,'save fictional activity settings');return saved.data.settings;}
const contact=await crm(source,{action:'save',kind:'contacts',data:{name:'Portable history contact'}}),company=await crm(source,{action:'save',kind:'companies',data:{name:'Portable history company'}});
check(contact.status===200&&company.status===200,'source records created');
await settings(source,actor,s=>({...s,types:[{label:'Legacy discovery',archived:false}],callOutcomes:[...s.callOutcomes,{label:'Reached decision maker',archived:false}]}));
const fixtures=[
 {type:'Note',recordId:contact.data.id,body:'Historical note; 财务\n=SUM(A1:A2)',occurredAt:'2026-09-30T10:00:00.000Z',assignedTo:'Former owner'},
 {type:'Call',recordId:contact.data.id,body:'Discussed the project.\nKeep the original call text.',occurredAt:'2026-09-20T10:00:00.000Z',activityType:'Legacy discovery',outcome:'Reached decision maker',durationSeconds:0,direction:'Inbound',assignedTo:'Former caller'},
 {type:'Meeting',recordId:company.data.id,body:'Historical meeting log; no invitation.',occurredAt:'2026-09-25T10:00:00.000Z',activityType:'Legacy discovery',outcome:'Completed',durationSeconds:1800,assignedTo:'Former organizer'},
 ...['Email','LinkedIn','SMS','WhatsApp','Postal mail'].map((type,i)=>({type,recordId:contact.data.id,body:'Historical '+type+' log; no delivery.\n财务',occurredAt:'2026-10-0'+(i+1)+'T10:00:00.000Z',assignedTo:'Former correspondent',...(type!=='Postal mail'?{direction:i%2?'Outbound':'Inbound'}:{})})),
];
for(const f of fixtures)check((await crm(source,{action:'activity',...f,autoAssociate:false})).status===200,'source '+f.type+' logged');
let state=await crm(source);
for(const f of fixtures){const a=state.data.activities.find(a=>a.body===f.body);check(a&&a.createdByName===author,'source author label');check((await request(source,'/api/activity-associations',{id:a.id,recordId:f.recordId,targetId:f.recordId===contact.data.id?company.data.id:contact.data.id,linked:true,revision:a.revision})).status===200,'full '+f.type+' association fixture');}
await settings(source,actor,s=>({...s,types:s.types.map(o=>({...o,archived:true})),callOutcomes:s.callOutcomes.map(o=>o.label==='Reached decision maker'?{...o,archived:true}:o)}));
state=await crm(source);const originals=state.data.activities;
const exported=await transfer(source,{action:'export',ids:[company.data.id]}),p=exported.data;
check(exported.status===200&&p.version===4,'compiled v4 export: '+JSON.stringify(p).slice(0,250));
check(p.records.length===2&&p.notes.length===1&&p.activities.length===7,'bounded mixed full graph');
check(p.activityOptions.types[0].archived&&p.activityOptions.callOutcomes[0].archived,'used archived source choices retained');
check(p.activities.every(a=>a.recordIds.length===2)&&!JSON.stringify(p.activities).includes('createdById'),'links retained, foreign author identity excluded');
let v=await transfer(destination,{action:'preview',package:p});check(v.status===200&&v.data.calls===1&&v.data.meetings===1&&v.data.activityCounts.Email===1&&v.data.activityCounts['Postal mail']===1&&v.data.errors.length===2,'unavailable labels require explicit review');
for(const user of [actor,browserActor])await settings(destination,user,s=>({...s,types:[{label:'Discovery',archived:false}],callOutcomes:[...s.callOutcomes,{label:'Historical connected',archived:true}]}));
v=await transfer(destination,{action:'preview',package:p});check(v.status===200&&v.data.mapping.activityOptions.filter(m=>!m.targetLabel).length===2,'different names never guessed');
const mapping={...v.data.mapping,activityOptions:v.data.mapping.activityOptions.map(m=>({...m,targetLabel:m.catalog==='types'?'Discovery':m.sourceLabel==='Reached decision maker'?'Historical connected':m.sourceLabel}))};
v=await transfer(destination,{action:'preview',package:p,mapping});check(v.status===200&&!v.data.errors.length,'explicit historical type/outcome map accepted');
let input={action:'import',package:p,mapping,reviewHash:v.data.reviewHash,ackAutomation:true};
await settings(destination,actor,s=>s);check((await transfer(destination,input)).status===409,'stale activity settings review rejected');check((await crm(destination)).data.records.length===0,'stale review wrote no records');
v=await transfer(destination,{action:'preview',package:p,mapping});input={...input,reviewHash:v.data.reviewHash};const imported=await transfer(destination,input),result=imported.data;
check(imported.status===200&&result.calls===1&&result.meetings===1&&result.notes===1&&result.activityMap.length===7&&result.noteMap.length===1,'atomic mixed import and ID maps: '+JSON.stringify(result).slice(0,200));
state=await crm(destination);const record=id=>result.recordMap.find(m=>m.sourceId===id).targetId;
for(const a of p.activities){const copied=state.data.activities.find(t=>t.id===result.activityMap.find(m=>m.sourceId===a.id).targetId),original=originals.find(t=>t.id===a.id);
 check(copied&&copied.body===original.body&&copied.createdAt===original.createdAt&&copied.updatedAt===original.updatedAt&&copied.occurredAt===original.occurredAt,'exact '+a.type+' body and dates');
 check(copied.createdById===null&&copied.createdByName===author&&copied.assignedTo===a.assignedTo&&copied.revision===0,'historical '+a.type+' authorship and new revision');
 check(copied.activityType===(['Call','Meeting'].includes(a.type)?'Discovery':null)&&copied.outcome===(a.type==='Call'?'Historical connected':a.type==='Meeting'?'Completed':null)&&copied.durationSeconds===a.durationSeconds&&copied.direction===a.direction,'reviewed '+a.type+' details');
 check(copied.recordId===record(a.recordId)&&copied.recordIds.length===2&&a.recordIds.every(id=>copied.recordIds.includes(record(id))),'full '+a.type+' links remapped');
}
check(state.data.activities.length===8&&state.data.records.every(r=>r.lastActivity==='2026-10-05T10:00:00.000Z'&&r.lastContacted==='2026-10-04T10:00:00.000Z'),'native outreach date includes messages; newer postal mail updates activity only');
check((await transfer(destination,input)).data.replayed===true,'mixed receipt replay');
const receipt=await request(destination,'/api/record-transfers?packageId='+p.id);check(receipt.status===200&&receipt.data.activityMap.length===7,'saved activity maps retained');
check((await request(destination,'/api/record-transfers?packageId='+p.id,undefined,actor+'-other')).status===404,'activity receipt owner isolation');
const changed=structuredClone(input);changed.mapping.activityOptions[0].targetLabel='Changed';check((await transfer(destination,changed)).status===409,'changed activity mapping conflicts with receipt');
const forged=structuredClone(p);forged.id=randomUUID();forged.activities[0].createdById='forged';check((await transfer(destination,{action:'preview',package:forged})).status===400,'foreign identity injection rejected');
await settings(destination,actor,s=>s);check((await transfer(destination,input)).data.replayed===true,'receipt recovery precedes changed settings validation');
const reexport=await transfer(destination,{action:'export',ids:[record(company.data.id)]});check(reexport.status===200&&reexport.data.activities.length===7&&reexport.data.activityOptions.callOutcomes.some(o=>o.label==='Historical connected'&&o.archived),'re-export retains reviewed archived labels');
const copiedCall=state.data.activities.find(a=>a.type==='Call');check((await crm(destination,{action:'editActivity',id:copiedCall.id,recordId:copiedCall.recordId,revision:copiedCall.revision,body:'Edited after historical import',occurredAt:copiedCall.occurredAt})).status===200,'ordinary edit retains imported archived outcome');
state=await crm(destination);check(state.data.activities.find(a=>a.id===copiedCall.id).outcome==='Historical connected'&&(await transfer(destination,input)).data.replayed===true,'edited historical log keeps labels and replay does not overwrite it');

const bulkAt='2026-09-01T10:00:00.000Z',base={recordId:'bulk',recordIds:['bulk'],body:'Historical activity; '+('Bounded text. '.repeat(50)),createdAt:bulkAt,occurredAt:null,updatedAt:null,revision:5,createdByName:'Former author',assignedTo:null};
const bulk={format:'harbor-core-transfer',version:3,id:randomUUID(),exportedAt:bulkAt,records:[{id:'bulk',kind:'contacts',data:'{"name":"Bounded mixed history"}',createdAt:bulkAt,updatedAt:bulkAt}],properties:[],pipelines:[],members:[],associations:[],notes:[{...base,id:'note',type:'Note'}],activities:Array.from({length:999},(_,i)=>({...base,id:'log-'+i,type:i%2?'Meeting':'Call',activityType:null,outcome:i%2?'Completed':'Connected',durationSeconds:i,direction:i%2?null:'Outbound'})),activityOptions:{types:[],callOutcomes:[{label:'Connected',archived:false}],meetingOutcomes:[{label:'Completed',archived:false}]}};
const bulkActor=actor+'-bulk',bv=await transfer(destination,{action:'preview',package:bulk},bulkActor);check(bv.status===200&&!bv.data.errors.length&&bv.data.calls+bv.data.meetings+bv.data.notes===1000,'1,000 mixed activities preview');
const bi={action:'import',package:bulk,mapping:bv.data.mapping,reviewHash:bv.data.reviewHash,ackAutomation:true},br=await transfer(destination,bi,bulkActor);check(br.status===200&&br.data.activityMap.length===999&&br.data.noteMap.length===1,'1,000 mixed activities atomically imported');
check((await transfer(destination,bi,bulkActor)).data.replayed===true,'1,000 mixed activities replay');
const be=await transfer(destination,{action:'export',ids:[br.data.recordMap[0].targetId]},bulkActor);check(be.status===200&&be.data.activities.length+be.data.notes.length===1000,'1,000 mixed activities re-export');
const channelBulk={...bulk,id:randomUUID(),version:4,activityOptions:{types:[],callOutcomes:[],meetingOutcomes:[]},activities:bulk.activities.map((a,i)=>({...a,type:['Email','LinkedIn','SMS','WhatsApp','Postal mail'][i%5],activityType:null,outcome:null,durationSeconds:null,direction:i%5===4?null:'Inbound'}))};
const channelActor=actor+'-channels-bulk',cv=await transfer(destination,{action:'preview',package:channelBulk},channelActor);check(cv.status===200&&!cv.data.errors.length&&Object.values(cv.data.activityCounts).reduce((a,b)=>a+b,0)===999,'1,000 all-channel activities preview');
const ci={action:'import',package:channelBulk,mapping:cv.data.mapping,reviewHash:cv.data.reviewHash,ackAutomation:true},cr=await transfer(destination,ci,channelActor);check(cr.status===200&&cr.data.activityMap.length===999&&cr.data.noteMap.length===1,'1,000 all-channel activities atomically imported');
check((await transfer(destination,ci,channelActor)).data.replayed===true,'1,000 all-channel activities replay');
const ce=await transfer(destination,{action:'export',ids:[cr.data.recordMap[0].targetId]},channelActor);check(ce.status===200&&ce.data.version===4&&ce.data.activities.length+ce.data.notes.length===1000,'1,000 all-channel activities re-export');
// Exercise every reverse expression index in the compiled D1 runtime as well
// as the activity-only graph above. Node SQLite has a different compound limit.
const primaryActor=actor+'-primary';
const primaryCompany=await crm(source,{action:'save',kind:'companies',data:{name:'Indexed primary company'}},primaryActor);
check(primaryCompany.status===200,'primary company fixture');
const primaryContact=await crm(source,{action:'save',kind:'contacts',data:{name:'Indexed primary contact',companyId:primaryCompany.data.id}},primaryActor);
check(primaryContact.status===200,'primary contact fixture');
for(const kind of ['deals','tickets','leads','tasks']){
 const r=await crm(source,{action:'save',kind,data:{name:'Indexed primary '+kind,...(kind==='tasks'?{relatedId:primaryContact.data.id}:{companyId:primaryCompany.data.id,contactId:primaryContact.data.id})}},primaryActor);
 check(r.status===200,'primary '+kind+' fixture: '+JSON.stringify(r.data).slice(0,150));
}
const primaryExport=await transfer(source,{action:'export',ids:[primaryCompany.data.id]},primaryActor);
check(primaryExport.status===200&&primaryExport.data.records.length===6&&primaryExport.data.version===1,'compiled primary frontier closes all six kinds: '+JSON.stringify(primaryExport.data).slice(0,150));
writeFileSync(dir+'/api-proof.json' ,JSON.stringify({checks,actor,browserActor,sourceIds:{contact:contact.data.id,company:company.data.id},result,package:p,mapping,bulkLogs:1000,bulkBytes:Buffer.byteLength(JSON.stringify(bulk))},null,2));
console.log(JSON.stringify({status:'passed',checks,records:2,notes:1,calls:1,meetings:1,otherChannels:5,bulkLogs:1000,bulkBytes:Buffer.byteLength(JSON.stringify(bulk)),providerConnections:0}));
