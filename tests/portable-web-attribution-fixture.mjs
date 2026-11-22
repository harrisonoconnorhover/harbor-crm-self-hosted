import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyWebAttribution({request,origin,headers,other,sql}){
  const reports='/api/web-attribution',forms='/api/lead-forms',siteId=randomUUID(),visitor=randomUUID();
  const siteOrigin='https://field-day.example.test',collector='/api/public/journey?siteId='+siteId;
  const read=(path,auth=headers)=>request(path,{headers:auth});
  const post=(path,data,auth=headers,from=origin)=>request(path,{method:'POST',headers:{...auth,origin:from,'content-type':'application/json'},body:JSON.stringify(data)});
  const ok=async promise=>{const r=await promise;assert.ok(r.ok,await r.clone().text());return r.json();};
  const accepted=async promise=>{const r=await promise;assert.equal(r.status,202,await r.text());return r;};
  const site={id:siteId,revision:0,name:'Field days',origin:siteOrigin,enabled:true};
  const report=(params={},auth=headers)=>ok(read(reports+'?'+new URLSearchParams(params),auth));
  const pointer={siteId,visitor};
  const touch=(source,path,more={})=>({...pointer,eventId:randomUUID(),source,medium:'referral',campaign:'field-day',path,...more});
  const formId=randomUUID(),foreignForm=randomUUID();
  async function prepareForm(id,auth){
    await ok(post(forms,{action:'save',id,revision:0,definition:{title:'Field day inquiry',captureContacts:true}},auth));
    await ok(post(forms,{action:'setEnabled',id,revision:1,enabled:true},auth));
  }
  const inquiry=(email,journey=pointer)=>({id:randomUUID(),revision:2,payload:{name:'Morgan Sample',email},journey,website:''});
  const submit=(id,body)=>ok(post('/api/public/forms/'+id,body,{}));
  assert.equal((await read(reports,{})).status,401);
  assert.equal((await post(reports,site,headers,siteOrigin)).status,403);
  assert.equal((await post(reports,{...site,origin:siteOrigin+'/private'})).status,400);
  const created=await ok(post(reports,site));assert.equal(created.revision,1);assert.equal(created.origin,siteOrigin);
  assert.deepEqual((await report({},other)).sites,[]);
  assert.equal((await post(reports,{...site,name:'Changed concurrently'})).status,409);
  assert.ok(!(await post(reports,{...site,revision:1,origin:'https://different.example.test'})).ok);
  await prepareForm(formId,headers);await prepareForm(foreignForm,other);
  const first=touch('newsletter','/features'),secondary=touch('partner','/demo',{medium:undefined,campaign:'second-campaign'});
  const options=await request(collector,{method:'OPTIONS',headers:{origin:siteOrigin,'access-control-request-method':'POST'}});
  assert.equal(options.status,204);assert.equal(options.headers.get('access-control-allow-origin'),siteOrigin);
  assert.ok(!(await post(collector,first,{},'https://another.example.test')).ok);
  assert.ok(!(await post(collector,{...first,path:'/profile?email=morgan@example.test'},{},siteOrigin)).ok);
  await post(collector,first,{'sec-gpc':'1'},siteOrigin);
  assert.equal((await report()).pageviews,0);
  const parallel=await Promise.all([post(collector,first,{},siteOrigin),post(collector,first,{},siteOrigin)]);
  for(const r of parallel)assert.equal(r.status,202,await r.text());
  await accepted(post(collector,secondary,{},siteOrigin));
  await accepted(post(collector,touch('webinar','/pricing',{visitor:randomUUID()}),{},siteOrigin));
  assert.equal((await report()).pageviews,3);
  // The retained journey starts before both shorter reporting periods.
  await sql`UPDATE portable_page_events SET at=at-(CASE WHEN event_id=${first.eventId} THEN 15 ELSE 9 END)::bigint*86400000
    WHERE site_id=${siteId} AND event_id IN (${first.eventId},${secondary.eventId})`;
  const converted=inquiry('journey-one@example.test');
  await submit(formId,converted);await submit(formId,converted);
  await submit(foreignForm,inquiry('other-site@example.test'));
  await submit(formId,inquiry('bad-pointer@example.test',{siteId:'broken'}));
  await submit(formId,{...inquiry('honey@example.test'),website:'bot'});
  const traffic=(group='source',extra={})=>report({tab:'traffic',siteId,group,...extra});
  const visits=await traffic();
  assert.equal(visits.pageviews,3);assert.equal(visits.visitors,2);
  assert.deepEqual(visits.rows.map(row=>row.label),['newsletter','partner','webinar']);
  assert.deepEqual((await traffic('medium')).rows,[
    {label:'referral',views:2,visitors:2},{label:'(Not tagged)',views:1,visitors:1},
  ]);
  assert.deepEqual((await traffic('campaign')).rows.map(row=>[row.label,row.views]),[['field-day',2],['second-campaign',1]]);
  assert.deepEqual((await traffic('page')).rows.map(row=>row.label),['/demo','/features','/pricing'].map(path=>siteOrigin+path));
  assert.deepEqual((await report({tab:'traffic'},other)).rows,[]);
  assert.equal((await read(reports+'?tab=traffic&siteId='+siteId,other)).status,404);
  assert.equal((await read(reports+'?tab=traffic&afterViews=2')).status,400);
  assert.ok(!JSON.stringify(visits).includes(visitor));
  for(const partial of ['beforeAt=1','through=1','beforeId='+formId+'&beforeAt=2']){
    assert.equal((await read(reports+'?'+partial)).status,400);
    assert.equal((await read('/?view=web-attribution&'+partial)).status,404);
  }
  const firstReport=await report({siteId,inquiryId:converted.id});
  assert.equal(firstReport.conversions,1);
  assert.equal(firstReport.recent[0].inquiryId,converted.id);
  assert.deepEqual(firstReport.path.map(e=>e.path),['/features','/demo']);
  assert.equal(firstReport.pathTotal,2);
  const contactId=firstReport.selected.contactId;
  assert.ok(contactId);
  const contactReport=await report({contactId,siteId});
  assert.equal(contactReport.contact.id,contactId);
  assert.equal(contactReport.pageviews,null,'Anonymous traffic is not a contact metric.');
  assert.deepEqual(contactReport.recent.map(row=>row.inquiryId),[converted.id]);
  assert.equal((await read(reports+'?contactId='+contactId,other)).status,404);
  assert.equal((await read(reports+'?contactId='+randomUUID())).status,404);
  // A repeat inquiry without tracking links to the same contact.
  await submit(formId,inquiry('journey-one@example.test',{siteId:'broken'}));
  await verifyContactAccess({request,headers,read,ok,sql,other,reports,forms,formId,siteId,contactId,inquiryId:converted.id});
  const rows=Object.fromEntries(firstReport.sources.map(row=>[row.source,row]));
  assert.equal(rows.newsletter.first,1);assert.equal(rows.partner.last,1);
  assert.equal(Number(rows.newsletter.linear),0.5);assert.equal(Number(rows.partner.linear),0.5);
  assert.deepEqual(firstReport.mediums,[{label:'(Not tagged)',first:0,last:1,linear:0.5},{label:'referral',first:1,last:0,linear:0.5}]);
  assert.deepEqual(firstReport.campaigns,[{label:'field-day',first:1,last:0,linear:0.5},{label:'second-campaign',first:0,last:1,linear:0.5}]);
  const currentWeek=await report({siteId,period:'7d',inquiryId:converted.id});
  assert.deepEqual([currentWeek.pageviews,currentWeek.conversions,currentWeek.pathTotal],[1,1,2]);
  assert.deepEqual(currentWeek.sources,firstReport.sources,'Credit includes earlier touches on an inquiry submitted this week.');
  const exactInquiry='/?view=forms&formId='+formId+'&submissionId='+converted.id;
  assert.equal((await read(exactInquiry,other)).status,404);
  assert.equal((await read('/?view=forms&formId='+foreignForm+'&submissionId='+converted.id,other)).status,404);
  assert.equal(new URL((await read(exactInquiry,{})).headers.get('location'),origin).searchParams.get('return_to'),exactInquiry);
  const priorWeek=await report({siteId,period:'previous7d'});
  assert.deepEqual([priorWeek.pageviews,priorWeek.conversions,priorWeek.recent.length],[1,0,0]);
  assert.deepEqual((await traffic('source',{period:'previous7d'})).rows.map(r=>r.label),['partner']);
  assert.deepEqual((await traffic('source',{period:'24h'})).rows.map(r=>r.label),['webinar']);
  assert.equal((await read(reports+'?period=forever')).status,400);
  assert.equal((await read(reports+'?tab=traffic&period=forever')).status,400);
  assert.equal((await read(reports+'?period=previous7d&inquiryId='+converted.id)).status,404);
  // Move only this fictional submission to eight days ago, after its second visit.
  const originalTime=firstReport.selected.convertedAt;
  await sql`UPDATE portable_form_conversions SET converted_at=${originalTime-8*86400000} WHERE inquiry_id=${converted.id}`;
  const priorConversion=await report({siteId,period:'previous7d',inquiryId:converted.id});
  assert.deepEqual(priorConversion.campaigns,firstReport.campaigns);
  assert.deepEqual([priorConversion.conversions,priorConversion.recent[0].inquiryId],[1,converted.id]);
  assert.equal((await report({siteId,period:'7d'})).conversions,0);
  await sql`UPDATE portable_form_conversions SET converted_at=${originalTime} WHERE inquiry_id=${converted.id}`;
  const isolated=await report({},other);
  assert.equal(isolated.conversions,0);assert.deepEqual(isolated.campaigns,[]);
  assert.ok(!(await read(reports+'?siteId='+siteId,other)).ok);
  const [stored]=await sql`SELECT visitor_hash FROM portable_page_events WHERE site_id=${siteId} AND event_id=${first.eventId}`;
  assert.match(stored.visitor_hash,/^[0-9a-f]{64}$/);assert.notEqual(stored.visitor_hash,visitor);
  const receipts=await ok(read(forms+'?formId='+formId));
  assert.equal(receipts.results.find(r=>r.id===converted.id).journeySite,siteId);
  await sql`UPDATE portable_page_events SET at=at-31::bigint*86400000 WHERE site_id=${siteId} AND visitor_hash=${stored.visitor_hash}`;
  await accepted(post(collector,touch('social','/later'),{},siteOrigin));
  assert.equal((await sql`SELECT count(*)::int AS n FROM portable_page_events WHERE site_id=${siteId} AND event_id=${first.eventId}`)[0].n,0);
  assert.equal((await report({inquiryId:converted.id})).pathTotal,2);
  assert.deepEqual((await traffic()).rows.map(row=>row.label),['social','webinar']);
  const longVisitor=randomUUID(),longPointer={siteId,visitor:longVisitor};
  for(let n=0;n<105;n++){
    const middle=n>=50&&n<55;
    await accepted(post(collector,touch(n===104?'closing-source':'opening-source','/step-'+n,{
      visitor:longVisitor,medium:middle?'partner':'channel-'+n,campaign:middle?'middle-only':'launch',
    }),{},siteOrigin));
  }
  const long=inquiry('long-path@example.test',longPointer);
  await submit(formId,long);
  const summary=await report({inquiryId:long.id});
  assert.equal(summary.pathTotal,105);
  const positions=summary.path.map(x=>x.path);
  assert.deepEqual(positions,[...Array.from({length:50},(_,i)=>'/step-'+i),...Array.from({length:50},(_,i)=>'/step-'+(55+i))]);
  const closing=summary.sources.find(row=>row.source==='closing-source');
  assert.equal(closing.last,1);
  assert.ok(Math.abs(Number(closing.linear)-1/105)<1e-8);
  const credit=(rows,label)=>rows.find(row=>row.label===label);
  assert.ok(Math.abs(credit(summary.campaigns,'middle-only').linear-5/105)<1e-8);
  assert.ok(Math.abs(credit(summary.mediums,'partner').linear-5/105)<1e-8);
  assert.equal(summary.mediums.length,101);
  assert.ok(credit(summary.mediums,'Other (combined)').linear>0);
  assert.ok(Math.abs(summary.mediums.reduce((n,row)=>n+row.linear,0)-summary.conversions)<1e-8);
  // Pre-upgrade snapshots only have the bounded path and complete source counts.
  await sql`UPDATE portable_form_conversions SET utm_counts=NULL WHERE site_id=${siteId}`;
  const old=await report({siteId});
  assert.deepEqual(old.sources,summary.sources);
  assert.equal(credit(old.campaigns,'middle-only'),undefined);
  assert.deepEqual(credit(old.campaigns,'launch'),credit(summary.campaigns,'launch'));
  for(const rows of [old.mediums,old.campaigns]){
    const unknown=credit(rows,'(Earlier visits unavailable)');
    assert.equal(unknown.first,0);assert.equal(unknown.last,0);
    assert.ok(Math.abs(unknown.linear-5/105)<1e-8);
    assert.ok(Math.abs(rows.reduce((n,row)=>n+row.linear,0)-old.conversions)<1e-8);
  }
  await ok(post(forms,{action:'removeInquiry',formId,submissionId:long.id}));
  const paused=await ok(post(reports,{...site,revision:1,enabled:false}));
  assert.equal(paused.enabled,false);
  assert.ok(!(await post(collector,touch('none','/'),{},siteOrigin)).ok);
  await submit(formId,inquiry('paused@example.test'));
  assert.equal((await report()).conversions,1);
  await ok(post(forms,{action:'removeInquiry',formId,submissionId:converted.id}));
  assert.equal((await report()).conversions,0);
  const incoming=await ok(read(forms+'?formId='+formId));
  assert.ok(incoming.results.some(r=>r.payload?.email==='bad-pointer@example.test'));
  // A separate site has enough tied groups to paginate and realistic traffic volume.
  const volumeSite=randomUUID(),volumeOrigin='https://traffic.example.test';
  await ok(post(reports,{...site,id:volumeSite,origin:volumeOrigin}));
  await sql`INSERT INTO portable_page_events (site_id,event_id,visitor_hash,at,path,source,medium,campaign)
    SELECT ${volumeSite},gen_random_uuid(),repeat(md5((n%1000)::text),2),
      floor(extract(epoch from now())*1000)::bigint-((n+(n-1)/40)%20+1)*86400000::bigint,
      '/product','source-'||lpad((n%40)::text,2,'0'),'email','launch'
    FROM generate_series(1,70000) n`;
  const start=performance.now(),pageOne=await traffic('source',{siteId:volumeSite});
  console.log('Local traffic report grouped 70,000 fictional views in '+Math.round(performance.now()-start)+' ms (HTTP).');
  assert.equal(pageOne.pageviews,70000);assert.equal(pageOne.visitors,1000);assert.equal(pageOne.rows.length,25);
  assert.deepEqual(pageOne.rows[0],{label:'source-00',views:1750,visitors:25});
  const later={...first,siteId:volumeSite,eventId:randomUUID(),source:'source-39'};
  await accepted(post('/api/public/journey?siteId='+volumeSite,later,{},volumeOrigin));
  const pageTwo=await traffic('source',{siteId:volumeSite,...pageOne.next});
  assert.equal(pageTwo.pageviews,70000);assert.equal(pageTwo.rows.length,15);assert.equal(pageTwo.next,null);
  assert.deepEqual([...pageOne.rows,...pageTwo.rows].map(r=>r.label),Array.from({length:40},(_,i)=>'source-'+String(i).padStart(2,'0')));
  const staleCursor={...pageOne.next,through:Date.now()-31*86400000};
  assert.deepEqual((await traffic('source',{siteId:volumeSite,period:'previous7d',...staleCursor})).rows,[]);
  const priorVolume=await traffic('source',{siteId:volumeSite,period:'previous7d'});
  assert.equal(priorVolume.pageviews,24500);
  assert.equal(priorVolume.rows.length,25);
  const priorPageTwo=await traffic('source',{siteId:volumeSite,period:'previous7d',...priorVolume.next});
  assert.equal(priorPageTwo.pageviews,priorVolume.pageviews);
  assert.equal(new Set([...priorVolume.rows,...priorPageTwo.rows].map(row=>row.label)).size,40);
  assert.equal(priorPageTwo.next,null);
  const newest=await traffic('source',{siteId:volumeSite});
  assert.equal(newest.pageviews,70001);assert.equal(newest.rows[0].label,'source-39');
  assert.ok((await report({tab:'traffic'})).pageviews>newest.pageviews);
  assert.deepEqual((await report({tab:'traffic'},other)).rows,[]);
  const js=await read('/journey.js',{});assert.equal(js.status,200);assert.match(js.headers.get('content-type'),/javascript/);
  assert.match(await js.text(),/HarborJourney/);
}

async function verifyContactAccess({request,headers,read,ok,sql,other,reports,forms,formId,siteId,contactId,inquiryId}){
  // Follow the same contact through Forms and Marketing analytics, including a saved link opened directly.
  const relatedReads=()=>sql`SELECT e.record_ids,e.actor_email FROM portable_record_access_events e
    WHERE e.action='related' AND e.kind='contacts' AND e.record_ids @> ARRAY[${contactId}]::uuid[]`;
  const receiptCount=async()=>(await relatedReads()).length;
  const beforeReads=await receiptCount();
  const journeyQuery=new URLSearchParams({contactId,inquiryId:inquiryId,siteId});
  const journeyApi=reports+'?'+journeyQuery,journeyPage='/?view=web-attribution&'+journeyQuery;
  const receiptPage='/?view=forms&formId='+formId+'&submissionId='+inquiryId;
  const receiptApi=forms+'?formId='+formId;
  for(const path of [journeyApi,journeyPage,receiptPage,receiptApi]){
    assert.equal((await request(path,{method:'HEAD',headers})).status,200,path);
    assert.equal((await read(path,other)).status,404,path);
  }
  await ok(read(reports+'?siteId='+siteId));await ok(read(reports+'?tab=traffic&siteId='+siteId));
  assert.equal(await receiptCount(),beforeReads,'No contact disclosed on aggregate, denied or headers-only reads.');
  for(const path of [reports+'?inquiryId='+inquiryId,reports+'?contactId='+contactId,journeyApi,journeyPage,receiptPage]){
    const before=await receiptCount();
    assert.equal((await read(path)).status,200,path);
    assert.equal(await receiptCount(),before+1,'One linked-contact entry for '+path);
  }
  const beforeList=await receiptCount();
  const inquiryPage=await ok(read(receiptApi));
  const expectedIds=[...new Set(inquiryPage.results.flatMap(row=>row.contactId?[row.contactId]:[]))].sort();
  assert.ok(expectedIds.length>1);
  assert.equal(inquiryPage.results.filter(row=>row.contactId===contactId).length,2);
  const events=await relatedReads();
  assert.equal(events.length,beforeList+1);
  assert.ok(events.some(event=>event.actor_email==='owner@example.test'&&
    JSON.stringify(event.record_ids.toSorted())===JSON.stringify(expectedIds)));

  const history=await read('/?view=record-access&kind=contacts&action=related&record='+contactId);
  assert.equal(history.status,200);
  assert.match(await history.text(),/Linked record preview/);
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT fixture_inquiry_audit_unavailable
    CHECK (kind <> 'contacts' OR action <> 'related') NOT VALID`;
  try{
    for(const path of [receiptApi,journeyApi]){
      const response=await read(path);
      assert.equal(response.status,503,path);
      assert.ok(!(await response.text()).includes(contactId));
    }
    assert.equal((await read(reports+'?siteId='+siteId)).status,200);
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT fixture_inquiry_audit_unavailable`;}
}
