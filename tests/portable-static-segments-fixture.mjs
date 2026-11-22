import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const endpoint='/api/segments';
const post=(request,origin,headers,path,body)=>request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
const page=(id,extra={})=>endpoint+'?'+new URLSearchParams({id,...extra});

export async function verifyPortableStaticSegments({request,origin,headers,other,sql}){
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const send=(path,body,auth=headers,site=origin)=>post(request,site,auth,path,body);
  const save=(segment,auth=headers)=>send(endpoint,{action:'save',segment},auth);
  const get=(path,auth=headers)=>request(path,{headers:auth});
  const segmentPage=async(id,options)=>{
    const result=await get(page(id,options));
    assert.equal(result.status,200,await result.clone().text());
    return result.json();
  };
  const createSegment=async(input)=>{
    const result=await save(input);
    assert.equal(result.status,201,await result.clone().text());
    return (await result.json()).segment;
  };
  const mutation=(id,revision,contactIds,operation='add',requestId=randomUUID())=>
    ({action:'members',id,revision,contactIds,operation,requestId});
  const label='Static '+randomUUID()+' 20%_\\';
  const createContact=async(suffix,lifecycle,auth=headers)=>{
    const result=await send('/api/crm',{action:'save',kind:'contacts',data:{name:label+' '+suffix,lifecycle}},auth);
    assert.equal(result.status,201,await result.clone().text());
    return (await result.json()).record;
  };
  const archive=async(contact,action)=>{
    const result=await send('/api/recycle-bin',{action,id:contact.id,expectedRevision:contact.revision,requestId:randomUUID()});
    assert.equal(result.status,200,await result.clone().text());
    return (await result.json()).receipt;
  };
  const lifecycle=async(contact,value)=>{
    const result=await send('/api/crm',{action:'save',kind:'contacts',id:contact.id,expectedRevision:contact.revision,
      data:{...contact.data,lifecycle:value}});
    assert.equal(result.status,200,await result.clone().text());
    return (await result.json()).record;
  };
  const first=await createContact('First','Evangelist');
  const second=await createContact('Second','Customer');
  const outside=await createContact('Later matches','Lead');
  const archived=await createContact('Archived','Evangelist');
  const foreign=await createContact('Foreign','Evangelist',other);
  await archive(archived,'archive');
  const definition={id:randomUUID(),revision:0,name:label+' snapshot',kind:'contacts',mode:'static',
    criteria:{groups:[
      [{field:'name',operator:'contains',value:label},{field:'lifecycle',operator:'eq',value:'Evangelist'}],
      [{field:'name',operator:'contains',value:label},{field:'lifecycle',operator:'eq',value:'Customer'}],
    ]}};
  const draft={...definition,initialMembers:'snapshot'};
  const snapshot=await createSegment(draft);
  const empty=await createSegment({...definition,id:randomUUID(),name:label+' empty'});
  const active=await createSegment({...definition,id:randomUUID(),mode:'active',name:label+' active'});
  assert.equal(snapshot.mode,'static');
  assert.equal(Object.hasOwn(snapshot,'initialMembers'),false);
  assert.equal((await segmentPage(empty.id)).total,'0');
  const initial=await segmentPage(snapshot.id,{limit:1});
  const next=await segmentPage(snapshot.id,{limit:1,after:initial.next});
  assert.equal(initial.total,'2');
  assert.equal(next.total,'2');
  assert.equal(next.next,null);
  assert.deepEqual(new Set([initial.items[0].id,next.items[0].id]),new Set([first.id,second.id]));
  assert.equal((await segmentPage(snapshot.id,{q:'First'})).items[0].id,first.id);
  const snapshotPage='/?view=segments&segment='+snapshot.id+'&';
  const matched=await get(snapshotPage+new URLSearchParams({memberQ:label.toLowerCase()+' first'}));
  assert.equal(matched.status,200);
  const matchingHtml=await matched.text();
  assert.match(matchingHtml,/<h2 id="portable-segment-members">Matching members · 1<\/h2>/);
  assert.ok(matchingHtml.includes('/?contact='+first.id));
  assert.ok(!matchingHtml.includes('/?contact='+second.id));
  const nonmember=await get(snapshotPage+new URLSearchParams({memberQ:'Later matches'}));
  assert.equal(nonmember.status,200);
  assert.match(await nonmember.text(),/<h2 id="portable-segment-members">Matching members · 0<\/h2>/);
  const candidates=await segmentPage(snapshot.id,{candidates:'true',q:label,limit:1});
  assert.deepEqual(candidates.items.map(item=>item.id),[outside.id]);
  assert.equal(candidates.total,'1');
  assert.equal(candidates.next,null);
  assert.equal((await get(page(snapshot.id),other)).status,404);
  assert.equal((await get(page(snapshot.id,{candidates:'true'}),other)).status,404);
  assert.equal((await get(page(active.id,{candidates:'true'}))).status,404);
  assert.equal((await get(endpoint+'?activeOnly=false')).status,400);
  const choices=await (await get(endpoint+'?'+new URLSearchParams({activeOnly:'true',q:label,limit:'1'}))).json();
  assert.deepEqual(choices.segments.map(item=>item.id),[active.id]);
  assert.equal(choices.next,null);
  const workflows=await get('/?view=workflows');
  assert.equal(workflows.status,200);
  const workflowPage=await workflows.text();
  assert.ok(workflowPage.includes(active.id));
  assert.ok(!workflowPage.includes(snapshot.id));
  assert.equal((await send('/api/workflows',{action:'save',id:randomUUID(),revision:0,definition:{
    name:label,trigger:'contact_segment',segmentId:snapshot.id,delayMinutes:0,body:'Should not run',
  }})).status,404);

  const changedFirst=await lifecycle(first,'Lead');
  const changedOutside=await lifecycle(outside,'Evangelist');
  assert.deepEqual(new Set((await segmentPage(snapshot.id)).items.map(item=>item.id)),new Set([first.id,second.id]));
  assert.equal((await save({...definition,revision:1,mode:'active'})).status,409);
  assert.equal((await save({...draft,revision:1})).status,400);
  const edited=await save({...definition,revision:1,name:label+' edited',criteria:{groups:[]}});
  assert.equal(edited.status,200,await edited.clone().text());
  assert.deepEqual((await edited.json()).segment.criteria,snapshot.criteria);

  const firstAdd=mutation(empty.id,1,[first.id,second.id]);
  assert.equal((await send(endpoint,firstAdd,other)).status,404);
  assert.equal((await send(endpoint,firstAdd,headers,'https://outside.example.test')).status,403);
  assert.equal((await send(endpoint,mutation(active.id,1,[first.id]))).status,400);
  assert.equal((await send(endpoint,mutation(empty.id,1,[first.id,first.id.toUpperCase()]))).status,400);
  assert.equal((await send(endpoint,mutation(empty.id,1,[first.id,foreign.id]))).status,400);
  assert.equal((await send(endpoint,mutation(empty.id,1,[first.id,archived.id]))).status,400);
  assert.equal((await segmentPage(empty.id)).total,'0');
  const competitors=await Promise.all([send(endpoint,firstAdd),send(endpoint,{...firstAdd,requestId:randomUUID()})]);
  assert.deepEqual(competitors.map(result=>result.status).sort(),[200,409]);
  const {receipt:firstReceipt}=await competitors.find(result=>result.status===200).json();
  const committed={...firstAdd,requestId:firstReceipt.requestId};
  assert.equal(firstReceipt.revision,2);
  assert.equal((await segmentPage(empty.id)).total,'2');
  const removed=await send(endpoint,mutation(empty.id,2,[second.id],'remove'));
  assert.equal(removed.status,200,await removed.clone().text());
  assert.equal((await removed.json()).receipt.revision,3);
  const replay=await send(endpoint,{...committed,contactIds:[second.id,first.id]});
  assert.deepEqual(await replay.json(),{receipt:firstReceipt});
  assert.equal((await segmentPage(empty.id)).total,'1');
  assert.equal((await segmentPage(empty.id)).segment.revision,3);
  assert.equal((await send(endpoint,{...committed,operation:'remove'})).status,409);
  assert.equal((await send(endpoint,{...committed,id:snapshot.id})).status,409);

  const archivedFirst=await archive(changedFirst,'archive');
  assert.equal((await segmentPage(snapshot.id)).total,'1');
  assert.equal((await segmentPage(empty.id)).total,'0');
  assert.equal((await send(endpoint,{action:'delete',id:empty.id,revision:3})).status,200);
  assert.equal((await send(endpoint,committed)).status,404);
  const recreated=await createSegment({...definition,id:empty.id,name:label+' recreated'});
  assert.equal(recreated.revision,1);
  assert.equal((await send(endpoint,committed)).status,409);
  await archive(archivedFirst,'restore');
  assert.equal((await segmentPage(snapshot.id)).total,'2');
  assert.equal((await segmentPage(empty.id)).total,'0');

  const recoveryReplay=mutation(snapshot.id,2,[changedOutside.id]);
  const accepted=await send(endpoint,recoveryReplay);
  assert.equal(accepted.status,200,await accepted.clone().text());
  const recoveryReceipt=await accepted.json();
  const hidden=await archive(second,'archive');
  const expected=await segmentPage(snapshot.id);
  assert.equal(expected.total,'2');
  assert.ok(!expected.items.some(item=>item.id===hidden.id));
  await reset();
  return {snapshotId:snapshot.id,expected,hidden,recoveryReplay,recoveryReceipt};
}

export async function verifyRestoredPortableStaticSegments({request,origin,owner,other,fixture}){
  const {snapshotId,expected,hidden,recoveryReplay,recoveryReceipt}=fixture;
  assert.deepEqual(await (await request(page(snapshotId),{headers:owner})).json(),expected);
  assert.equal((await request(page(snapshotId),{headers:other})).status,404);
  const replay=await post(request,origin,owner,endpoint,recoveryReplay);
  assert.equal(replay.status,200,await replay.clone().text());
  assert.deepEqual(await replay.json(),recoveryReceipt);
  const restore=await post(request,origin,owner,'/api/recycle-bin',
    {action:'restore',id:hidden.id,expectedRevision:hidden.revision,requestId:randomUUID()});
  assert.equal(restore.status,200,await restore.clone().text());
  const restored=await (await request(page(snapshotId),{headers:owner})).json();
  assert.equal(restored.segment.revision,expected.segment.revision);
  assert.equal(restored.total,'3');
  assert.ok(restored.items.some(item=>item.id===hidden.id));
}
