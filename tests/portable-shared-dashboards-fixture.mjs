import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const api='/api/reporting';

export async function verifySharedDashboard({request,origin,headers,other,sql,workspaceId,unattachedReportId}){
  const read=(path,auth=other)=>request(path,{headers:auth});
  const write=(body,auth=headers,path=api)=>request(path,{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  async function item(response,expected){
    assert.equal(response.status,expected,await response.clone().text());
    return (await response.json()).item;
  }
  const [foreign]=await sql`SELECT w.id FROM private_workspaces w JOIN login_identities i ON i.id=w.owner_id
    WHERE i.email='other@example.test'`;
  const ids=Array.from({length:27},()=>randomUUID()).sort(),extra=Array.from({length:4},()=>randomUUID());
  const when='2089-08-01T14:00:00.000Z',reportName='Customer follow-up by lifecycle',name='Sales team dashboard';
  const rows=ids.map((id,i)=>({id,workspace_id:workspaceId,revision:1,created_at:when,updated_at:when,
    archived_at:null,data:sql.json({name:'Fictional customer '+(i+1),lifecycle:i===0?'Customer':'Evangelist'})}));
  const makeRow=(index,workspace,lifecycle,created=when,archived=null)=>({...rows[0],id:extra[index],
    workspace_id:workspace,created_at:created,archived_at:archived,data:sql.json({name:'Excluded sample '+index,lifecycle})});
  const definition={name:reportName,kind:'contacts',groupBy:'lifecycle',createdDateRange:{from:'2089-08-01',through:'2089-08-01'}};
  const scope='&workspaceId='+workspaceId;
  const list=api+'?view=dashboards'+scope;
  let report,dashboard;
  try{
    await sql`INSERT INTO contacts ${sql([...rows,makeRow(0,foreign.id,'Evangelist'),
      makeRow(1,workspaceId,'Evangelist',when,when),makeRow(2,workspaceId,'Evangelist','2089-07-31T23:59:59Z'),
      makeRow(3,workspaceId,'Evangelist','2089-08-02T00:00:00Z')])}`;
    report=await item(await write({action:'report',definition}),201);
    const cards=[{reportId:report.id,wide:false}];
    dashboard=await item(await write({action:'dashboard',definition:{name,cards}}),201);
    const detail=api+'?view=dashboard&id='+dashboard.id+scope;
    const screen='/?view=dashboards&dashboardId='+dashboard.id+scope;
    const records=api+'?view=dashboardRecords&id='+dashboard.id+'&reportId='+report.id+scope;
    const settings={action:'dashboard',id:dashboard.id,definition:{name,cards}};
    async function visible(){
      const response=await read(list+'&search='+encodeURIComponent(name));
      assert.equal(response.status,200);
      return (await response.json()).items.some(row=>row.id===dashboard.id);
    }
    assert.equal(dashboard.teamVisible,false);
    assert.equal(await visible(),false);
    assert.equal((await read(detail)).status,404);
    assert.equal((await read(records)).status,404);
    let updated=await item(await write({...settings,revision:1,teamVisible:true}),200);
    assert.equal(updated.teamVisible,true);
    assert.equal(await visible(),true);
    updated=await item(await write({...settings,revision:updated.revision}),200);
    assert.equal(updated.teamVisible,true,'An older editor can rename a shared dashboard without resetting its audience.');
    assert.equal((await write({...settings,revision:updated.revision-1,teamVisible:false})).status,409);
    const view=await read(detail);
    assert.equal(view.status,200);
    assert.equal(view.headers.get('cache-control'),'private, no-store');
    const body=await view.json();
    assert.equal(body.item.id,dashboard.id);
    assert.deepEqual(body.cards[0].result,{total:'27',count:'27',rows:[
      {key:'Evangelist',label:'Evangelist',count:'26',value:'26'},{key:'Customer',label:'Customer',count:'1',value:'1'}
    ],truncated:false});
    const page=await read(screen);
    assert.equal(page.status,200);
    const html=await page.text();
    assert.match(html,/View matching records/);
    assert.doesNotMatch(html,/>Save dashboard<|>Delete dashboard<|>Open report<|>New dashboard</);
    assert.equal((await write({...settings,revision:updated.revision,teamVisible:false},other,api+'?workspaceId='+workspaceId)).status,403);
    assert.equal((await read(api+'?id='+report.id)).status,404);
    assert.equal((await read(records.replace(report.id,unattachedReportId??randomUUID()))).status,404);
    assert.equal((await read(records.replace(workspaceId,randomUUID()))).status,404);

    const filtered=records+'&group=Evangelist';
    const first=await (await read(filtered)).json();
    assert.equal(first.kind,'contacts');
    assert.deepEqual(first.records.map(row=>row.id),ids.slice(1,26));
    assert.equal(first.next,ids[25]);
    const next=await (await read(filtered+'&after='+first.next)).json();
    assert.deepEqual(next,{kind:'contacts',records:[{id:ids[26],name:'Fictional customer 27'}],next:null});
    const customer=await (await read(records+'&group=Customer')).json();
    assert.deepEqual(customer.records.map(row=>row.id),ids.slice(0,1));
    const all=await (await read(records)).json();
    assert.deepEqual(all.records.map(row=>row.id),ids.slice(0,25));
    const linked=await read('/api/crm?id='+customer.records[0].id+scope);
    assert.equal(linked.status,200);
    assert.equal((await linked.json()).id,ids[0]);
    updated=await item(await write({...settings,revision:updated.revision,teamVisible:false}),200);
    assert.equal(updated.teamVisible,false);
    assert.equal(await visible(),false);
    for(const path of [detail,screen,filtered])assert.equal((await read(path)).status,404);
  }finally{
    if(dashboard)await sql`DELETE FROM portable_dashboards WHERE workspace_id=${workspaceId} AND id=${dashboard.id}`;
    if(report)await sql`DELETE FROM portable_reports WHERE workspace_id=${workspaceId} AND id=${report.id}`;
    await sql`DELETE FROM contacts WHERE id IN ${sql([...ids,...extra])}`;
  }
}
