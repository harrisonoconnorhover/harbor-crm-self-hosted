import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';

const source=process.env.TRANSFER_SOURCE_URL,destination=process.env.TRANSFER_DESTINATION_URL;
for(const url of [source,destination])if(!url||!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('Two disposable local Workers are required.');
assert.notEqual(source,destination);
const actor='portable-notes-'+randomUUID(),author='Fictional source author';let checks=0;
const check=(ok,label)=>{assert.ok(ok,label);checks++;};
async function request(url,path,body,user=actor){
 const r=await fetch(url+path,{method:body?'POST':'GET',headers:{origin:url,'content-type':'application/json','oai-authenticated-user-id':user,'oai-authenticated-user-email':user+'@example.test','oai-authenticated-user-full-name':encodeURIComponent(author),'oai-authenticated-user-full-name-encoding':'percent-encoded-utf-8'},...(body?{body:JSON.stringify(body)}:{})});
 return {status:r.status,...await r.json()};
}
const crm=(url,body)=>request(url,'/api/crm',body),transfer=(url,body)=>request(url,'/api/record-transfers',body);
const contact=await crm(source,{action:'save',kind:'contacts',data:{name:'Portable note contact'}}),company=await crm(source,{action:'save',kind:'companies',data:{name:'Portable note company'}});
check(contact.status===200&&company.status===200,'source records created');
const body='Plan; 财务\nPreserve the complete note.\n=SUM(A1:A2)',occurredAt='2026-09-20T10:00:00.000Z';
check((await crm(source,{action:'activity',recordId:contact.id,type:'Note',body,occurredAt,assignedTo:'Original assignee',autoAssociate:false})).status===200,'source note logged');
let state=await crm(source),original=state.activities.find(a=>a.body===body);check(original&&original.createdByName===author,'source author metadata available');
check((await request(source,'/api/activity-associations',{id:original.id,recordId:contact.id,targetId:company.id,linked:true,revision:original.revision})).status===200,'secondary note link saved');
check((await crm(source,{action:'activity',recordId:contact.id,type:'Email',body:'Excluded email log',occurredAt:'2026-09-21T10:00:00.000Z',autoAssociate:false})).status===200,'outreach exclusion fixture logged locally');
state=await crm(source);original=state.activities.find(a=>a.id===original.id);
const {status:exportStatus,...exported}=await transfer(source,{action:'export',ids:[company.id]});check(exportStatus===200&&exported.version===2,'compiled version2 export: '+JSON.stringify(exported).slice(0,600));
check(exported.records.length===2&&exported.notes.length===1,'note expands graph and copies once');
check(exported.notes[0].body===body&&exported.notes[0].recordIds.length===2,'text and full links exported');
check(!JSON.stringify(exported.notes).includes('createdById'),'source author identity excluded');
const preview=await transfer(destination,{action:'preview',package:exported});check(preview.status===200&&preview.notes===1&&!preview.errors.length,'compiled note preview');
const input={action:'import',package:exported,mapping:preview.mapping,reviewHash:preview.reviewHash,ackAutomation:true},result=await transfer(destination,input);
check(result.status===200&&result.notes===1&&result.noteMap.length===1,'compiled atomic note import');
const map=id=>result.recordMap.find(m=>m.sourceId===id).targetId;
state=await crm(destination);const copied=state.activities.find(a=>a.id===result.noteMap[0].targetId);
check(copied&&copied.body===body&&copied.createdAt===original.createdAt&&copied.updatedAt===original.updatedAt&&copied.occurredAt===occurredAt,'dates/text preserved by compiled D1');
check(copied.createdById==null&&copied.createdByName===author&&copied.assignedTo==='Original assignee','author label retained with foreign ID cleared');
check(copied.recordId===map(contact.id)&&copied.recordIds.includes(map(company.id)),'all note record IDs remapped');
check(state.activities.length===1&&state.records.every(r=>!r.lastContacted&&r.lastActivity===occurredAt),'only notes copied; Last activity derived, Last contacted unchanged');
const again=await transfer(destination,{action:'export',ids:[map(company.id)]});check(again.status===200&&again.notes.length===1&&again.notes[0].body===body,'destination re-export');
check((await transfer(destination,input)).replayed===true,'same package reconciles');
const receipt=await request(destination,'/api/record-transfers?packageId='+exported.id);check(receipt.status===200&&receipt.noteMap[0].targetId===result.noteMap[0].targetId,'saved outcome retains note ID map');
check((await request(destination,'/api/record-transfers?packageId='+exported.id,undefined,actor+'-other')).status===404,'note outcome owner isolation');
const changed=structuredClone(input);changed.package.notes[0].body='Changed input';check((await transfer(destination,changed)).status===409,'note change conflicts with existing package receipt');
const injected=structuredClone(exported);injected.id=randomUUID();injected.notes[0].createdById='forged';check((await transfer(destination,{action:'preview',package:injected})).status===400,'API rejects identity injection');

const bulkAt='2026-09-01T10:00:00.000Z',bulk={format:'harbor-core-transfer',version:2,id:randomUUID(),exportedAt:bulkAt,records:[{id:'bulk',kind:'contacts',data:'{"name":"Bounded portable notes"}',createdAt:bulkAt,updatedAt:bulkAt}],properties:[],pipelines:[],members:[],associations:[],notes:Array.from({length:1000},(_,i)=>({id:'note-'+i,type:'Note',recordId:'bulk',recordIds:['bulk'],body:'Historical note '+i+'\n'+'Bounded text. '.repeat(50),createdAt:bulkAt,occurredAt:null,updatedAt:null,revision:3,createdByName:'Former author',assignedTo:null}))};
const bulkActor=actor+'-bulk',bulkPreview=await request(destination,'/api/record-transfers',{action:'preview',package:bulk},bulkActor);check(bulkPreview.status===200&&bulkPreview.notes===1000&&!bulkPreview.errors.length,'1,000-note preview');
const bulkInput={action:'import',package:bulk,mapping:bulkPreview.mapping,reviewHash:bulkPreview.reviewHash,ackAutomation:true},bulkResult=await request(destination,'/api/record-transfers',bulkInput,bulkActor);check(bulkResult.status===200&&bulkResult.notes===1000&&bulkResult.noteMap.length===1000,'packetized 1,000-note import');
check((await request(destination,'/api/record-transfers',bulkInput,bulkActor)).replayed===true,'1,000-note replay');
const bulkExport=await request(destination,'/api/record-transfers',{action:'export',ids:[bulkResult.recordMap[0].targetId]},bulkActor);check(bulkExport.status===200&&bulkExport.notes.length===1000,'1,000-note bounded re-export');
writeFileSync('.harbor/portable-notes/api-proof.json',JSON.stringify({checks,actor,sourceIds:{contact:contact.id,company:company.id,note:original.id},result,package:exported,bulkBytes:JSON.stringify(bulk).length,bulkNotes:1000},null,2));
console.log(JSON.stringify({status:'passed',checks,notes:1,linkedRecords:2,bulkNotes:1000,bulkBytes:JSON.stringify(bulk).length,providerConnections:0}));
