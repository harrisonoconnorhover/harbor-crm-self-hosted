import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Use the ordinary owner session and route. Raw inserts stand in for older imported
// values that today's record editor already rejects. The database is disposable.
export async function verifyPortableDataQuality({request,origin,headers,other,sql},browserPage){
  const route='/?view=settings&section=data-quality';
  async function page(auth=headers){
    const response=await request(route,{headers:auth});
    assert.equal(response.status,200,await response.clone().text());
    return (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replaceAll('<!-- -->','');
  }
  function metric(html,label){
    const text=html.replace(/<\/?a\b[^>]*>/g,'');
    const found=text.match(new RegExp('<dt>'+label+'</dt><dd>([^<]+)</dd>'));
    assert.ok(found,label);
    return found[1];
  }
  const ws=await (await request('/api/workspaces',{headers})).json();
  assert.ok(ws.owned,'The fixture needs an initialized owner workspace.');
  const before=await page(),foreignBefore=await page(other);
  for(const area of ['Duplicates','Properties','Records','Integrations','Workflows'])assert.ok(before.includes('<h2>'+area+'</h2>'));
  for(const path of ['/?view=duplicates&amp;kind=contacts','/?view=settings&amp;section=properties','/?view=settings&amp;section=integrations','/?view=workflows#recent-runs'])assert.ok(before.includes('href="'+path+'"'),path);
  const checked=['Unused','No data','Similar labels','Formatting issues','Contacts missing a name','Companies with formatting issues',
    'Never enrolled a record','Workflows with unresolved run issues'];
  const beforeCounts=checked.map(label=>Number(metric(before,label)));
  const renewal=randomUUID(),appointment=randomUUID(),website=randomUUID();
  const sparse= randomUUID(),used=randomUUID(),configured=randomUUID(),contact=randomUUID(),company=randomUUID(),withdrawn=randomUUID();
  const wf=randomUUID(),unusedFlow=randomUUID(),run=randomUUID(),view=randomUUID();
  await sql.begin(async tx=>{
    await tx`INSERT INTO portable_custom_properties(workspace_id,kind,id,label,type,options,revision) VALUES
      (${ws.owned},'contacts',${sparse},'Quality  fixture field','text','[]',1),
      (${ws.owned},'contacts',${used},'e-mail','number','[]',1),
      (${ws.owned},'contacts',${configured},'Quality view field','text','[]',1),
      (${ws.owned},'contacts',${renewal},'Quality renewal date','date','[]',1),
      (${ws.owned},'contacts',${appointment},'Quality appointment','datetime','[]',1)`;
    await tx`INSERT INTO portable_saved_views(workspace_id,id,kind,name,filters,columns,revision)
      VALUES(${ws.owned},${view},'contacts','Quality diagnostic view','{}',${sql.json(['name','custom:'+configured])},1)`;
    await tx`INSERT INTO contacts(workspace_id,id,revision,data,archived_at,created_at,updated_at)
      VALUES(${ws.owned},${contact},1,${sql.json({name:'',custom:{[used]:0,[renewal]:'2025-02-29',[appointment]:'2026-01-09T09:30:00'}})},null,now(),now()),
        (${ws.owned},${withdrawn},1,${sql.json({name:'',custom:{[sparse]:'Archived'}})},now(),now(),now())`;
    await tx`INSERT INTO companies(workspace_id,id,revision,data,created_at,updated_at)
      VALUES(${ws.owned},${company},1,'{"name":"Quality trial","domain":"incorrect/domain"}',now(),now())`;
    await tx`INSERT INTO contact_events(workspace_id,contact_id,revision,data,occurred_at,actor_id)
      SELECT c.workspace_id,c.id,1,c.data,now(),w.owner_id FROM contacts c JOIN private_workspaces w ON w.id=c.workspace_id WHERE c.workspace_id=${ws.owned} AND c.id=${contact}`;
    await tx`INSERT INTO portable_deal_workflows(workspace_id,id,revision,definition)
      VALUES(${ws.owned},${wf},1,'{"name":"Quality capacity trial","trigger":"manual_contact","actionKind":"note","delayMinutes":0,"body":"Quality trial"}'),(${ws.owned},${unusedFlow},1,'{"name":"Unenrolled trial","trigger":"manual_contact","actionKind":"note","delayMinutes":0,"body":"Quality trial"}')`;
    await tx`INSERT INTO portable_workflow_runs(workspace_id,id,workflow_id,workflow_revision,workflow_name,contact_id,contact_revision,issue,created_at)
      VALUES(${ws.owned},${run},${wf},1,'Quality capacity trial',${contact},1,'queue_full',1)`;
  });
  await browserPage.goto(origin+route);
  await browserPage.getByText('Review fields',{exact:true}).click();
  const fieldLink=browserPage.getByRole('link',{name:'Quality fixture field · Contact',exact:true});
  assert.equal(await fieldLink.getAttribute('href'),'/?view=settings&section=properties&kind=contacts#property-'+sparse);
  await fieldLink.click();
  const target=browserPage.locator(':target');
  await target.waitFor();
  assert.equal(await target.getAttribute('aria-label'),'Rename Quality  fixture field');
  assert.ok(await target.evaluate(el=>el.getBoundingClientRect().top>=0&&el.getBoundingClientRect().bottom<=innerHeight));
  await target.click();
  const editor=browserPage.getByRole('textbox',{name:'Property name',exact:true});
  assert.equal(await editor.inputValue(),'Quality  fixture field');
  assert.ok(await editor.evaluate(el=>el===document.activeElement));
  const owner=await page();
  const delta=checked.map((label,i)=>Number(metric(owner,label))-beforeCounts[i]);
  assert.deepEqual(delta,[1,2,1,3,1,1,1,1]);
  await sql`UPDATE contacts SET data=jsonb_set(data,ARRAY['custom',${renewal}::text],to_jsonb('2024-02-29'::text))
    WHERE workspace_id=${ws.owned} AND id=${contact}`;
  assert.equal(Number(metric(await page(),'Formatting issues')),Number(metric(owner,'Formatting issues'))-1);
  const affected=html=>html.match(/<a\b[^>]*>Review affected record<\/a>/g)?.some(link=>link.includes('href="/?contact='+contact+'"'))??false;
  assert.ok(affected(owner));
  const linked=await request('/?contact='+contact,{headers});
  assert.equal(linked.status,200);
  for(const invalid of ['2025-02-29T09:30:00Z','2026-01-09T24:00:00Z']){
    await sql`UPDATE contacts SET data=jsonb_set(data,ARRAY['custom',${appointment}::text],to_jsonb(${invalid}::text))
      WHERE workspace_id=${ws.owned} AND id=${contact}`;
    assert.equal(Number(metric(await page(),'Formatting issues')),Number(metric(before,'Formatting issues'))+2,invalid);
  }
  const repair=await request('/api/crm',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'save',kind:'contacts',id:contact,expectedRevision:1,
      data:{name:'Fictional quality repair',custom:{[appointment]:'2024-02-29T09:30:00.100-04:00'}}})});
  assert.equal(repair.status,200,await repair.clone().text());
  const repaired=await page();
  assert.equal(Number(metric(repaired,'Formatting issues')),Number(metric(before,'Formatting issues'))+1);
  assert.ok(!affected(repaired));
  // Imported legacy links can bypass the normal editor's URL normalization.
  await sql`INSERT INTO portable_custom_properties(workspace_id,kind,id,label,type,options,revision)
    VALUES (${ws.owned},'contacts',${website},'Quality profile link','url','[]',1)`;
  for(const invalid of ['not a link','ftp://files.example.test/path','https://user@example.test/path']){
    await sql`UPDATE contacts SET data=jsonb_set(data,ARRAY['custom',${website}::text],to_jsonb(${invalid}::text))
      WHERE workspace_id=${ws.owned} AND id=${contact}`;
    const flagged=await page();
    assert.ok(affected(flagged));
    assert.equal(Number(metric(flagged,'Formatting issues')),Number(metric(repaired,'Formatting issues'))+1,invalid);
  }
  const fixedLink=await request('/api/crm',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'save',kind:'contacts',id:contact,expectedRevision:2,
      data:{name:'Fictional quality repair',custom:{[website]:'example.test/profile?tab=about#contact'}}})});
  assert.equal(fixedLink.status,200,await fixedLink.clone().text());
  const afterLinkRepair=await page();
  assert.equal(metric(afterLinkRepair,'Formatting issues'),metric(repaired,'Formatting issues'));
  assert.ok(!affected(afterLinkRepair));
  assert.ok(owner.includes('Quality  fixture field'));
  assert.ok(owner.includes('href="/?contact='+contact+'"')||Number(metric(before,'Contacts missing a name'))>0);
  const foreign=await page(other);
  for(const label of checked)assert.equal(metric(foreign,label),metric(foreignBefore,label),label);
  assert.ok(!foreign.includes('Quality  fixture field'));
  await sql`UPDATE portable_workflow_runs SET operator_reviewed_at=2 WHERE workspace_id=${ws.owned} AND id=${run}`;
  assert.equal(metric(await page(),'Workflows with unresolved run issues'),metric(before,'Workflows with unresolved run issues'));
  // The navigation suite uses a fresh database. Leave any pre-existing integration intact.
  const seeded=await sql`INSERT INTO portable_marketing_audience_sync(workspace_id,generation,source_key,state,mapping,started_at,progressed_at)
    VALUES(${ws.owned},${randomUUID()},'fixture-source','failed','{"consentField":"Marketing__c","accountFields":[]}',now(),now())
    ON CONFLICT DO NOTHING RETURNING workspace_id`;
  if(seeded.length){
    assert.equal(metric(await page(),'Salesforce audience sync'),'Failed');
    await sql`UPDATE portable_marketing_audience_sync SET state='syncing',progressed_at=now()-interval '6 minutes' WHERE workspace_id=${ws.owned}`;
    assert.match(metric(await page(),'Salesforce audience sync'),/^Inactive/);
    assert.equal(metric(await page(other),'Salesforce audience sync'),metric(foreignBefore,'Salesforce audience sync'));
    await sql`DELETE FROM portable_marketing_audience_sync WHERE workspace_id=${ws.owned}`;
  }
  assert.equal((await request(route+'&workspaceId='+ws.owned,{headers:other})).status,404);
  await editor.fill('Quality fixture field');
  const [saved]=await Promise.all([
    browserPage.waitForResponse(response=>new URL(response.url()).pathname==='/api/custom-properties'&&response.request().method()==='POST'),
    browserPage.getByRole('button',{name:'Save name',exact:true}).click(),
  ]);
  assert.equal(saved.status(),200,await saved.text());
  assert.equal(Number(metric(await page(),'Formatting issues')),Number(metric(afterLinkRepair,'Formatting issues'))-1);
  // A requirement added later can leave an existing deal incomplete. Surface the
  // deal once even when two properties are missing, then clear it after repair.
  async function write(path,body){
    const response=await request(path,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.ok(response.ok,await response.clone().text());
    return response.json();
  }
  const stageMetric='Deals missing stage requirements';
  const prior=Number(metric(before,stageMetric));
  const {pipeline}=await write('/api/pipeline',{name:'Fictional renewal review',
    stages:[{name:'Review',outcome:'open'},{name:'Won',outcome:'won'},{name:'Lost',outcome:'lost'}]});
  const {property}=await write('/api/custom-properties',{action:'create',kind:'deals',label:'Renewal score',type:'number'});
  const {record}=await write('/api/crm',{action:'save',kind:'deals',pipelineId:pipeline.id,stageId:pipeline.stages[0].id,
    data:{name:'Fictional renewal awaiting details'}});
  const {record:dated}=await write('/api/crm',{action:'save',kind:'deals',pipelineId:pipeline.id,stageId:pipeline.stages[0].id,
    data:{name:'Fictional dated renewal',closeDate:'2031-06-01'}});
  await write('/api/pipeline',{id:pipeline.id,name:pipeline.name,expectedRevision:pipeline.revision,
    stages:pipeline.stages.map((stage,index)=>index===0?{...stage,requiredProperties:[
      {field:'closeDate',required:true},{field:'custom:'+property.id,required:true}]}:stage)});
  const incomplete=await page();
  assert.equal(Number(metric(incomplete,stageMetric)),prior+2);
  assert.equal(metric(await page(other),stageMetric),metric(foreignBefore,stageMetric));
  await write('/api/crm',{action:'save',kind:'deals',id:dated.id,expectedRevision:dated.revision,
    data:{name:dated.data.name,custom:{[property.id]:0}}});
  const remaining=await page();
  assert.equal(Number(metric(remaining,stageMetric)),prior+1);
  if(!prior)assert.ok(remaining.includes('href="/?kind=deals&amp;record='+record.id+'">'+stageMetric+'</a>'));
  await write('/api/crm',{action:'save',kind:'deals',id:record.id,expectedRevision:record.revision,
    data:{name:record.data.name,closeDate:'2031-05-20',custom:{[property.id]:0}}});
  assert.equal(Number(metric(await page(),stageMetric)),prior);
  // Remove only this drill's objects before other workflow and property screens use them.
  await sql.begin(async tx=>{
    await tx`DELETE FROM portable_workflow_runs WHERE workspace_id=${ws.owned} AND id=${run}`;
    await tx`DELETE FROM portable_deal_workflows WHERE workspace_id=${ws.owned} AND id IN (${wf},${unusedFlow})`;
    await tx`DELETE FROM portable_saved_views WHERE workspace_id=${ws.owned} AND id=${view}`;
    await tx`DELETE FROM portable_custom_properties WHERE workspace_id=${ws.owned} AND id IN (${used},${configured},${sparse},${renewal},${appointment},${website})`;
  });
}
