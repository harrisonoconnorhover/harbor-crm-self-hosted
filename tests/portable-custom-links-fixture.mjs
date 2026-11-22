import assert from 'node:assert/strict';
import {randomUUID as uuid} from 'node:crypto';

export async function verifyCustomLinks({send,get,ok,query,repWrite,workspace,repId,other,origin,sql,setViewScope}){
  const api='/api/custom-objects',projectType=uuid(),planType=uuid(),id=uuid();
  const define=(type,name)=>({action:'define',id:type,revision:0,definition:{name,fields:[]}});
  const create=(objectId,id,name,assigneeId)=>({action:'save',id,objectId,name,assigneeId,revision:0,schemaRevision:1});
  const action=(objectId,source,targetObjectId,target,revision,mode='linkCustom')=>({action:mode,objectId,id:source,targetObjectId,target,revision});
  const detail=(objectId,record,shared=false,extra={})=>ok(get(query({objectId,record,...extra},shared),shared?other:undefined));
  await ok(send(api,define(projectType,'Onboarding projects')));
  await ok(send(api,define(planType,'Support plans')));
  await ok(send(api,create(projectType,id,'North pier onboarding',repId)));
  await ok(send(api,create(planType,id,'North pier service agreement',repId)));
  const privatePlan=uuid(),otherProject=uuid();
  await ok(send(api,create(planType,privatePlan,'Confidential agreement',null)));
  await ok(send(api,create(projectType,otherProject,'North pier phase two',repId)));
  assert.equal((await repWrite(action(projectType,id,projectType,id,1))).status,400);
  assert.equal((await repWrite(action(projectType,id,planType,privatePlan,1))).status,404);
  const foreign=uuid();
  await ok(send(api,define(planType,'Other workspace plans'),other));
  await ok(send(api,create(planType,foreign,'Separate workspace agreement',null),other));
  assert.equal((await send(api,action(projectType,id,planType,foreign,1))).status,404);
  const forward=action(projectType,id,planType,id,1);
  const reverse=action(planType,id,projectType,id,1);
  const concurrent=await Promise.all([repWrite(forward),repWrite(reverse)]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  assert.equal((await ok(repWrite({...reverse,revision:2}))).revision,2);
  assert.equal((await repWrite({...reverse,action:'unlinkCustom'})).status,409);
  const [project,plan]=await Promise.all([detail(projectType,id,true),detail(planType,id,true)]);
  assert.deepEqual(project.customLinks.items.map(p=>[p.name,p.objectId,p.recordId,p.canUnlink]),[['North pier service agreement',planType,id,true]]);
  assert.deepEqual(plan.customLinks.items.map(p=>p.id),project.customLinks.items.map(p=>p.id));
  assert.equal(plan.record.revision,2);
  const receipt=await sql`SELECT record_ids FROM portable_record_access_events WHERE workspace_id=${workspace} AND actor_id=${repId}
    AND action='related' AND custom_object_id=${planType}`;
  assert.ok(receipt.some(row=>row.record_ids.includes(id)));
  await ok(repWrite({...reverse,revision:2,action:'unlinkCustom'}));
  assert.deepEqual((await detail(projectType,id)).customLinks.items,[]);
  if(process.env.HARBOR_TEST_PLAYWRIGHT){
    const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
    const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
    try{
      const context=await browser.newContext({viewport:{width:390,height:844}});
      const [name,value]=other.cookie.split('=');
      await context.addCookies([{name,value,url:origin}]);
      const tab=await context.newPage();
      await tab.goto(origin+'/?'+new URLSearchParams({view:'custom-objects',objectId:projectType,record:id,workspaceId:workspace}));
      await tab.getByText('Link a custom record',{exact:true}).click();
      await tab.getByRole('searchbox',{name:'Find a custom record'}).fill('North pier service agreement');
      await tab.getByRole('button',{name:'Search records',exact:true}).click();
      await tab.getByRole('button',{name:/^Link North pier service agreement/}).click();
      const peers=tab.getByRole('region',{name:'Linked custom records'});
      await peers.getByRole('link',{name:'North pier service agreement'}).click();
      await tab.getByRole('heading',{name:'North pier service agreement',exact:true}).waitFor();
      assert.equal(new URL(tab.url()).searchParams.get('workspaceId'),workspace);
      await peers.getByRole('button',{name:'Unlink North pier onboarding'}).click();
      await peers.getByText('No linked custom records on this page.').waitFor();
      assert.deepEqual((await detail(projectType,id)).customLinks.items,[]);
    }finally{await browser.close();}
  }
  const before=(await detail(projectType,id)).record.revision;
  await ok(send(api,action(projectType,id,projectType,otherProject,before)));
  await ok(send(api,action(projectType,id,planType,privatePlan,before+1)));
  assert.deepEqual((await detail(projectType,id,true)).customLinks.items.map(p=>p.recordId),[otherProject]);
  await ok(send(api,{action:'archive',objectId:projectType,id:otherProject,revision:2,archived:true}));
  assert.deepEqual((await detail(projectType,id,true)).customLinks.items,[]);
  await ok(send(api,{action:'archive',objectId:projectType,id:otherProject,revision:3,archived:false}));
  assert.deepEqual((await detail(projectType,id,true)).customLinks.items.map(p=>p.recordId),[otherProject]);
  await setViewScope('all');
  const visibleReadOnly=(await detail(projectType,id,true)).customLinks.items.find(p=>p.recordId===privatePlan);
  assert.equal(visibleReadOnly.canUnlink,false);
  const current=(await detail(projectType,id,true)).record.revision;
  assert.equal((await repWrite(action(projectType,id,planType,privatePlan,current,'unlinkCustom'))).status,404);
  await setViewScope('owned');

  // Seed the pagination boundary in bulk after exercising individual writes through the app.
  await sql`WITH added AS (
    INSERT INTO portable_object_records(workspace_id,object_id,id,name,data,revision)
    SELECT ${workspace},${projectType},gen_random_uuid(),'Onboarding phase '||n,'{"values":{}}',1 FROM generate_series(1,24) n
    RETURNING workspace_id,object_id,id)
    INSERT INTO portable_custom_record_links(workspace_id,id,left_object_id,left_record_id,right_object_id,right_record_id)
    SELECT workspace_id,gen_random_uuid(),object_id,least(id,${id}::uuid),object_id,greatest(id,${id}::uuid) FROM added`;
  const first=(await detail(projectType,id)).customLinks;
  assert.equal(first.items.length,25);
  const last=(await detail(projectType,id,false,{afterCustom:first.next})).customLinks;
  assert.equal(last.next,null);
  assert.equal(new Set([...first.items,...last.items].map(p=>p.id)).size,26);
}
