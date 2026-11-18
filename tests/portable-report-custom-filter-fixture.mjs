import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPortableReportCustomFilters({request,origin,headers,sql,workspaceId}){
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email='owner@example.test')`;
  await reset();
  const send=(path,body)=>request(path,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const marker='Report filter '+randomUUID().slice(0,8);
  const created=[];
  const property=async(label,type,options=[])=>{
    const response=await send('/api/custom-properties',{action:'create',kind:'contacts',label:marker+' '+label,type,options});
    assert.equal(response.status,201,await response.clone().text());
    const result=(await response.json()).property;
    created.push(result.id);
    return result;
  };
  const report=async(customFilter,kind='contacts')=>{
    const response=await send('/api/reporting',{action:'preview',definition:{name:marker,kind,metric:'count',measure:'',groupBy:'',sort:'value-desc',customFilter}});
    return {status:response.status,total:response.ok?Number((await response.json()).result.total):undefined};
  };
  try{
    const tier=await property('tier','select',['Gold','Silver']);
    const score=await property('score','number');
    const vip=await property('vip','checkbox');
    const tags=await property('tags','multiselect',['North','South']);
    const note=await property('note','text');
    const rows=[
      {[tier.id]:'Gold',[score.id]:5,[vip.id]:true,[tags.id]:['North'],[note.id]:'Fictional renewal call'},
      {[tier.id]:'Gold',[score.id]:7,[tags.id]:['North','South'],[note.id]:'Fictional pricing'},
      {[tier.id]:'Silver',[score.id]:5,[vip.id]:false},
    ];
    for(const [index,custom] of rows.entries()){
      const response=await send('/api/crm',{action:'save',kind:'contacts',data:{name:marker+' '+index,custom}});
      assert.equal(response.status,201,await response.clone().text());
    }
    const [{n:active}]=await sql`SELECT count(*)::int AS n FROM contacts WHERE workspace_id=${workspaceId} AND archived_at IS NULL`;

    assert.equal((await report({propertyId:tier.id,operator:'is',value:'gold'})).total,2,'select values match without case');
    assert.equal((await report({propertyId:tier.id,operator:'known'})).total,3);
    assert.equal((await report({propertyId:tier.id,operator:'unknown'})).total,active-3);
    assert.equal((await report({propertyId:score.id,operator:'is',value:5})).total,2);
    assert.equal((await report({propertyId:vip.id,operator:'is',value:true})).total,1);
    assert.equal((await report({propertyId:vip.id,operator:'known'})).total,1,'an unticked checkbox has no value');
    assert.equal((await report({propertyId:tags.id,operator:'contains',value:'South'})).total,1);
    assert.equal((await report({propertyId:tags.id,operator:'known'})).total,2);
    assert.equal((await report({propertyId:note.id,operator:'contains',value:'RENEWAL'})).total,1);
    assert.equal((await report({propertyId:note.id,operator:'is',value:'fictional pricing'})).total,1);

    // Invalid filters are refused; a filter on another object's or a deleted property matches nothing.
    assert.equal((await report({propertyId:tier.id,operator:'is'})).status,400);
    assert.equal((await report({propertyId:tier.id,operator:'known'},'tasks')).status,400);
    assert.equal((await report({propertyId:tier.id,operator:'known'},'companies')).total,0);
    assert.equal((await report({propertyId:randomUUID(),operator:'unknown'})).total,0);

    // A saved report keeps its custom filter.
    const saved=await send('/api/reporting',{action:'report',definition:{name:marker,kind:'contacts',metric:'count',measure:'',groupBy:'',sort:'value-desc',
      customFilter:{propertyId:tier.id,operator:'is',value:'Gold'}}});
    assert.equal(saved.status,201,await saved.clone().text());
    const {item}=await saved.json();
    const page=await (await request('/?'+new URLSearchParams({view:'reports',reportId:item.id}),{headers})).text();
    assert.match(page,new RegExp(marker+' tier is Gold'));
    await sql`DELETE FROM portable_reports WHERE id=${item.id}`;
  }finally{
    await sql`UPDATE contacts SET data=data - 'custom' WHERE workspace_id=${workspaceId} AND data->>'name' LIKE ${marker+'%'}`;
    await sql`DELETE FROM portable_custom_properties WHERE id = ANY(${created}::uuid[])`;
    await reset();
  }
}
