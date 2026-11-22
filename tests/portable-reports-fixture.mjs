import assert from 'node:assert/strict';
import {verifyRelatedCompanyReports} from './portable-related-company-report-fixture.mjs';
import {randomUUID} from 'node:crypto';

const path='/api/reporting';
const preview=(request,headers,origin,definition)=>request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify({action:'preview',definition})});
const exportReport=(request,headers,origin,source)=>request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify({action:'export',...source})});
const quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';
function expectedRows(result,includeCount=false,filtered=false){
  return [...result.rows,{label:filtered?'Matching records':'All records',value:result.total,count:result.count}].map(row=>
    [quote(row.label),quote(row.value),...(includeCount?[quote(row.count)]:[])].join(','));
}

async function verifyReportCatalog({request,origin,headers,other,sql,workspaceId}){
  const ids=Array.from({length:28},()=>randomUUID()).sort();
  const title='Fictional ÄLARM %_ report';
  const definition={name:title,kind:'contacts',metric:'count',measure:'',groupBy:'',sort:'label'};
  const foreignResponse=await request(path,{method:'POST',headers:{...other,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'report',definition})});
  assert.equal(foreignResponse.status,201,await foreignResponse.clone().text());
  const {item:foreign}=await foreignResponse.json();
  try{
    const rows=ids.map((id,index)=>({id,workspace_id:workspaceId,revision:1,updated_at:new Date().toISOString(),
      definition:sql.json({...definition,name:['Other saved report','Fictional ÄLARM XA report'][index]??`${title} ${index}`})}));
    await sql`INSERT INTO portable_reports ${sql(rows)}`;
    const search=new URLSearchParams({search:'älarm %_'}).toString();
    const catalog='/?view=reports';
    const read=(query,auth=headers)=>request(path+'?'+query,{headers:auth});
    const first=await read(search);
    assert.equal(first.status,200);
    const {items,next}=await first.json();
    assert.deepEqual(items.map(item=>item.id),ids.slice(2,-1));
    assert.equal(next,ids.at(-2));
    const second=await read('after='+next+'&'+search);
    assert.equal(second.status,200);
    const last=await second.json();
    assert.deepEqual(last.items.map(item=>item.id),ids.slice(-1));
    assert.equal(last.next,null);
    const foreignCatalog=await read(search,other);
    assert.equal(foreignCatalog.status,200);
    assert.deepEqual(await foreignCatalog.json(),{items:[foreign],next:null});
    assert.deepEqual(await (await read('limit=1&search=+++')).json(),await (await read('limit=1')).json());
    for(const invalid of ['search=%00','search='+('a'.repeat(121)),search+'&search=twice','id='+foreign.id+'&'+search]){
      assert.equal((await read(invalid)).status,400);
    }
    const secondLink=catalog+'&after='+next+'&'+search;
    const firstPage=await request(catalog+'&'+search,{headers});
    assert.equal(firstPage.status,200);
    const listHtml=(await firstPage.text()).replaceAll('&amp;','&');
    assert.match(listHtml,/name="search"[^>]*value="älarm %_"/);
    assert.ok(listHtml.includes(`href="${secondLink}">Next reports`));
    const detailLink=catalog+'&reportId='+ids.at(-1)+'&after='+next+'&'+search;
    const secondPage=await request(secondLink,{headers});
    assert.equal(secondPage.status,200);
    const secondHtml=(await secondPage.text()).replaceAll('&amp;','&');
    assert.ok(secondHtml.includes(`href="${catalog}&${search}">First reports`));
    assert.ok(secondHtml.includes(`href="${detailLink}"`));
    const detail=await request(detailLink,{headers});
    assert.equal(detail.status,200);
    const detailHtml=(await detail.text()).replaceAll('&amp;','&');
    assert.ok(detailHtml.includes(`href="${secondLink}" aria-current="page">Reports`));
    assert.match(detailHtml,/>Export CSV</);
    const redirect=await request(detailLink,{headers:{},redirect:'manual'});
    assert.equal(redirect.status,307);
    assert.equal(new URL(redirect.headers.get('location'),origin).searchParams.get('return_to'),detailLink);
    const noMatch=await request(catalog+'&reportId='+ids.at(-1)+'&search=unmatched',{headers});
    assert.equal(noMatch.status,200);
    assert.match(await noMatch.text(),/No matching reports on this page\./);
  }finally{
    await sql`DELETE FROM portable_reports WHERE id IN ${sql([...ids,foreign.id])}`;
  }
}

export async function verifyPortableReports({request,origin,headers,other,sql,workspaceId}){
  const resetBudgets=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await resetBudgets();
  await verifyRelatedCompanyReports({request,origin,headers,other,sql});
  await resetBudgets();
  const get=(query='',auth=headers)=>request(path+query,{headers:auth});
  const post=(data,auth=headers,query='',source=origin)=>request(path+query,{method:'POST',
    headers:{...auth,origin:source,'content-type':'application/json'},body:JSON.stringify(data)});
  async function result(definition,auth=headers){
    const response=await preview(request,auth,origin,definition);
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).result;
  }

  assert.equal((await get('',{})).status,401);
  assert.equal((await get('?limit=1&limit=2')).status,400);
  assert.equal((await get('?limit=51')).status,400);
  assert.equal((await get('?view=dashboards')).status,200);
  const pipeline={name:'Fictional pipeline amount',kind:'deals',metric:'sum',measure:'amount',groupBy:'stage',sort:'value-asc'};
  const filter={field:'closeDate',operator:'between',value:'2043-01-02',valueTo:'2043-01-05'};
  const createdDateRange={from:'2042-12-30',through:'2042-12-31'};
  const taskDueDateRange={from:'2051-04-10',through:'2051-04-12'};
  const dueDefinition={name:'Fictional follow-ups due',kind:'tasks',taskDueDateRange};
  const [ownerIdentity]=await sql`SELECT id,coalesce(nullif(trim(full_name),''),email) AS label FROM login_identities WHERE email='owner@example.test'`;
  const [otherIdentity]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const datedPipeline={...pipeline,filter};
  const wonInRange={...datedPipeline,dealOutcome:'won'};
  const defaultPipeline={...pipeline,dealPipelineId:'default'};
  assert.equal((await post({action:'export',definition:pipeline},{})).status,401);
  assert.equal((await post({action:'export',definition:pipeline},headers,'','https://elsewhere.example.test')).status,403);
  assert.equal((await post({action:'export',definition:pipeline},other,'?workspaceId='+workspaceId)).status,403);
  assert.equal((await post({action:'export',definition:{...pipeline,filters:{}}})).status,400);
  assert.equal((await post({action:'report',definition:pipeline},headers,'','https://elsewhere.example.test')).status,403);
  assert.equal((await post({action:'report',definition:pipeline},other,'?workspaceId='+workspaceId)).status,403);
  for(const invalid of [
    {...pipeline,kind:'companies'}, {...pipeline,groupBy:'name'}, {...pipeline,association:{kind:'contacts'}},
    {...pipeline,dealOutcome:'active'},
    {...pipeline,dealPipelineId:'Sales pipeline'},
    {...pipeline,dealStageId:'Closed won'},
    {...pipeline,dealPipelineId:'default',dealStageId:randomUUID()},
    {...pipeline,dealPipelineId:randomUUID(),dealStageId:'Closed won'},
    {name:'Wrong source',kind:'companies',dealOutcome:'won'},
    {name:'Wrong pipeline source',kind:'companies',dealPipelineId:'default'},
    {...pipeline,filter:{field:'status',operator:'eq',value:'Completed'}},
    {...datedPipeline,filter:{...filter,value:'2043-02-30'}},
    {...datedPipeline,filter:{...filter,valueTo:'2043-01-01'}},
    {...datedPipeline,filter:{...filter,operator:'on'}},
    {...datedPipeline,filter:{...filter,unknown:true}},
    {...pipeline,createdDateRange:{...createdDateRange,from:'0000-12-30'}},
    {...pipeline,createdDateRange:{...createdDateRange,through:'2042-12-29'}},
    {...pipeline,createdDateRange:{...createdDateRange,through:'2042-11-31'}},
    {...pipeline,createdDateRange:{from:createdDateRange.from}},
    {...pipeline,createdDateRange:{...createdDateRange,timeZone:'America/New_York'}},
    {...pipeline,taskDueDateRange},
    {...pipeline,taskAssigneeId:null},
    {...dueDefinition,taskAssigneeId:''},
    {...dueDefinition,taskDueDateRange:{...taskDueDateRange,through:'2051-04-09'}},
    {...dueDefinition,taskDueDateRange:{...taskDueDateRange,from:'2051-04-31'}},
    {name:'Wrong source',kind:'companies',filter:{field:'closeDate',operator:'between',value:filter.value,valueTo:filter.valueTo}},
    {name:'Unknown option',kind:'tasks',filter:{field:'status',operator:'eq',value:'Waiting'}},
    {name:'Wrong grouping',kind:'leads',groupBy:'stage'},
    {name:'Wrong source',kind:'tickets',filter:{field:'leadStage',operator:'eq',value:'Qualified'}},
    {name:'Unknown option',kind:'tickets',filter:{field:'ticketStatus',operator:'eq',value:'Queued'}},
    {name:'Wrong priority kind',kind:'tasks',ticketPriority:'Urgent'},
    {name:'Wrong source kind',kind:'contacts',ticketSource:'Email'},
    {name:'Wrong category kind',kind:'companies',ticketCategory:'Product question'},
    {name:'Unknown priority',kind:'tickets',ticketPriority:'Critical'},
    {name:'Unknown source',kind:'tickets',ticketSource:'Text message'},
    {name:'Empty source',kind:'tickets',ticketSource:''},
    {name:'Unknown category',kind:'tickets',ticketCategory:'Sales'},
    {name:'Empty category',kind:'tickets',ticketCategory:''},
    {name:'Wrong measure',kind:'leads',metric:'sum',measure:'amount'},
  ])assert.equal((await post({action:'preview',definition:invalid})).status,400);

  await resetBudgets();
  const createRecord=(kind,data,auth=headers)=>request('/api/'+kind,{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify({action:'save',data})});
  for(const response of [
    await createRecord('leads',{name:'Fictional foreign report lead',leadStage:'Qualified'},other),
    await createRecord('tickets',{name:'Fictional report open ticket',ticketStatus:'Waiting on contact'}),
    await createRecord('tickets',{name:'Fictional report closed ticket',ticketStatus:'Closed'}),
    await createRecord('tickets',{name:'Fictional foreign report ticket',ticketStatus:'Waiting on contact'},other),
  ])assert.equal(response.status,201,await response.clone().text());

  const leadTicketReports=[];
  for(const [kind,table,groupBy,value,groupLabel] of [
    ['contacts','contacts','lifecycle','Lead','Lifecycle stage'],['companies','companies','lifecycle','Lead','Lifecycle stage'],
    ['deals','deals','stage',null,'Deal stage'],['tasks','portable_tasks','status','Completed','Task status'],
    ['leads','portable_leads','leadStage','Qualified','Lead stage'],
    ['tickets','portable_tickets','ticketStatus','Waiting on contact','Ticket status'],
  ]){
    const active=['contacts','companies','deals','tasks'].includes(kind)?sql`AND archived_at IS NULL`:sql``;
    const [expected]=await sql`SELECT count(*)::text AS total FROM ${sql(table)} WHERE workspace_id=${workspaceId} ${active}`;
    const all=await result({name:'Count '+kind,kind});
    assert.deepEqual(all,{total:expected.total,count:expected.total,rows:[],truncated:false});
    const wideDates={from:'0001-01-01',through:'9999-12-31'};
    assert.deepEqual(await result({name:'Count by create date '+kind,kind,createdDateRange:wideDates}),all);
    const grouped=await result({name:'Group '+kind,kind,groupBy});
    assert.equal(grouped.total,expected.total);
    assert.equal(grouped.rows.reduce((sum,row)=>sum+Number(row.count),0),Number(expected.total));
    assert.equal(grouped.truncated,false);
    const download=await exportReport(request,headers,origin,{definition:{name:'Count '+kind,kind}});
    assert.equal(download.status,200);
    assert.equal(download.headers.get('cache-control'),'private, no-store');
    assert.equal(download.headers.get('content-type'),'text/csv; charset=utf-8');
    assert.equal(download.headers.get('x-content-type-options'),'nosniff');
    assert.equal(await download.text(),['"Group","Record count"',...expectedRows(all),''].join('\r\n'));
    if(value){
      const [matching]=await sql`SELECT count(*)::text AS total FROM ${sql(table)} WHERE workspace_id=${workspaceId}
        AND lower(data->>${groupBy})=${value.toLowerCase()} ${active}`;
      const definition={name:'Matching '+kind,kind,groupBy,filter:{field:groupBy,operator:'eq',value}};
      const selected=await result(definition);
      assert.equal(selected.total,matching.total);
      assert.equal(selected.count,matching.total);
      assert.ok(selected.rows.every(row=>row.label.toLowerCase()===value.toLowerCase()));
      const selectedCsv=await exportReport(request,headers,origin,{definition});
      assert.equal(selectedCsv.status,200);
      assert.equal(await selectedCsv.text(),[quote(groupLabel)+',"Record count"',...expectedRows(selected,false,true),''].join('\r\n'));
      if(kind==='leads'||kind==='tickets'){
        const expectedGroup={key:value,label:value,count:matching.total,value:matching.total};
        assert.ok(Number(matching.total)>0);
        assert.deepEqual(selected.rows,[expectedGroup]);
        assert.ok(grouped.rows.some(row=>row.key!==value&&Number(row.count)>0));
        const foreign=await result(definition,other);
        assert.deepEqual(foreign,{total:'1',count:'1',rows:[{...expectedGroup,count:'1',value:'1'}],truncated:false});
        assert.equal((await post({action:'preview',definition},other,'?workspaceId='+workspaceId)).status,403);
        leadTicketReports.push({definition,result:selected,groupLabel});
      }
    }
  }
  const [foreign]=await sql`SELECT count(*)::text AS total FROM deals JOIN private_workspaces ws ON ws.id=deals.workspace_id
    JOIN login_identities member ON member.id=ws.owner_id WHERE member.email='other@example.test'`;
  assert.equal((await result({name:'Other deals',kind:'deals'},other)).total,foreign.total);
  const otherCsv=await exportReport(request,other,origin,{definition:{name:'Other deals',kind:'deals'}});
  assert.equal(await otherCsv.text(),'"Group","Record count"\r\n"All records",'+quote(foreign.total)+'\r\n');
  const [expected]=await sql`SELECT sum((data->>'amount')::numeric)::text AS amount FROM deals WHERE workspace_id=${workspaceId}`;
  const before=await result(pipeline);
  const defaultBefore=await result(defaultPipeline);
  assert.equal(before.total,expected.amount);
  const groupedDownload=await exportReport(request,headers,origin,{definition:pipeline});
  assert.equal(groupedDownload.status,200);
  assert.equal(groupedDownload.headers.get('content-disposition'),'attachment; filename="harbor-report-Fictional-pipeline-amount.csv"');
  assert.equal(await groupedDownload.text(),['"Deal stage","Total deal amount","Records"',...expectedRows(before,true),''].join('\r\n'));

  // Seed 54 valid custom stages across three pipelines. The raw deal labels
  // deliberately precede a rename so the report must join the current catalog.
  const testPipelines=Array.from({length:6},(_,index)=>({workspace_id:workspaceId,id:randomUUID(),name:'Fictional report cap '+index,revision:1}));
  const formulaLabel='=Fictional("test"), label';
  const stageRows=testPipelines.flatMap((p,i)=>Array.from({length:18},(_,position)=>({
    workspace_id:workspaceId,pipeline_id:p.id,id:randomUUID(),name:i===0&&position===1?formulaLabel:'Report group '+String(i*18+position).padStart(2,'0'),
    outcome:position===16?'won':position===17?'lost':'open',position,
  })));
  const stamp=new Date().toISOString();
  const deals=stageRows.map((stage,index)=>({workspace_id:workspaceId,id:randomUUID(),revision:1,pipeline_id:stage.pipeline_id,
    stage_id:stage.id,data:sql.json({name:'Fictional report group',stage:'Earlier label',amount:0.01,
      closeDate:index<54?(index%2?filter.value:filter.valueTo):['2043-01-01','2043-01-06',''][index%3]}),
    created_at:stamp,updated_at:stamp}));
  const ids=testPipelines.map(p=>p.id);
  try{
    await sql`INSERT INTO deal_pipelines ${sql(testPipelines.slice(0,3))}`;
    await sql`INSERT INTO deal_pipeline_stages ${sql(stageRows.slice(0,54))}`;
    await sql`INSERT INTO deals ${sql(deals.slice(0,54))}`;
    const large=await result(pipeline);
    assert.equal(large.rows.length,50);
    assert.equal(large.truncated,true);
    assert.equal(Number(large.count),Number(before.count)+54);
    assert.equal(Math.round(Number(large.total)*100),Math.round(Number(before.total)*100)+54);
    assert.ok(large.rows.some(row=>row.label==='Report group 00'));
    assert.ok(large.rows.every(row=>row.label!=='Earlier label'));
    const full=await exportReport(request,headers,origin,{definition:pipeline});
    assert.equal(full.status,200);
    const raw=await full.text();
    const lines=raw.trimEnd().split('\r\n');
    assert.equal(lines.length,before.rows.length+54+2);
    assert.ok(raw.includes(quote('Report group 53')+',"0.01","1"'));
    assert.ok(raw.includes(quote("'"+formulaLabel)+',"0.01","1"'));
    assert.ok(!raw.includes('Earlier label'));
    assert.equal(lines.at(-1),[quote('All records'),quote(large.total),quote(large.count)].join(','));
    const csvRows=rows=>rows.map(row=>[
      quote(row.label===formulaLabel?"'"+row.label:row.label),quote(row.value),quote(row.count),
    ].join(','));
    assert.deepEqual(lines.slice(1,51),csvRows(large.rows));
    await sql`INSERT INTO deal_pipelines ${sql(testPipelines.slice(3))}`;
    await sql`INSERT INTO deal_pipeline_stages ${sql(stageRows.slice(54))}`;
    await sql`INSERT INTO deals ${sql(deals.slice(54))}`;
    const refused=await exportReport(request,headers,origin,{definition:pipeline});
    assert.equal(refused.status,413);
    assert.equal(refused.headers.get('content-disposition'),null);
    assert.match((await refused.json()).error,/more than 100 groups/);
    const dated=await result(datedPipeline);
    assert.deepEqual([dated.total,dated.count,dated.truncated,dated.rows.length],['0.54','54',true,50]);
    const datedWon=await result(wonInRange);
    assert.deepEqual([datedWon.total,datedWon.count,datedWon.rows.length],['0.03','3',3]);
    assert.deepEqual(datedWon.rows.map(row=>row.label),['Report group 16','Report group 34','Report group 52']);
    const selectedPipeline={...wonInRange,dealPipelineId:ids[0]};
    const selected=await result(selectedPipeline);
    assert.deepEqual([selected.total,selected.count,selected.rows.map(row=>row.label)],['0.01','1',['Report group 16']]);
    const selectedCsv=await exportReport(request,headers,origin,{definition:selectedPipeline});
    assert.equal(selectedCsv.status,200);
    assert.equal(await selectedCsv.text(),['"Deal stage","Total deal amount","Records"',...expectedRows(selected,true,true),''].join('\r\n'));
    assert.deepEqual(await result(selectedPipeline,other),{total:null,count:'0',rows:[],truncated:false});
    const selectedStage={...datedPipeline,dealPipelineId:ids[0],dealStageId:stageRows[16].id};
    assert.deepEqual(await result(selectedStage),selected);
    const stageCsv=await exportReport(request,headers,origin,{definition:selectedStage});
    assert.equal(await stageCsv.text(),['"Deal stage","Total deal amount","Records"',...expectedRows(selected,true,true),''].join('\r\n'));
    const empty={total:null,count:'0',rows:[],truncated:false};
    assert.deepEqual(await result({...selectedStage,dealPipelineId:ids[1]}),empty);
    assert.deepEqual(await result(selectedStage,other),empty);
    assert.deepEqual(await result(defaultPipeline),defaultBefore);
    const completeDated=await exportReport(request,headers,origin,{definition:datedPipeline});
    assert.equal(completeDated.status,200);
    const datedCsv=(await completeDated.text()).trimEnd().split('\r\n');
    assert.equal(datedCsv.length,56);
    assert.deepEqual(datedCsv.slice(1,51),csvRows(dated.rows));
    assert.ok(datedCsv.includes(quote('Report group 53')+',"0.01","1"'));
    assert.equal(datedCsv.at(-1),'"Matching records","0.54","54"');
  }finally{
    await sql`DELETE FROM deals WHERE workspace_id=${workspaceId} AND pipeline_id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM deal_pipeline_stages WHERE workspace_id=${workspaceId} AND pipeline_id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM deal_pipelines WHERE workspace_id=${workspaceId} AND id=ANY(${ids}::uuid[])`;
  }
  await resetBudgets();
  const saveDeal=(label,closeDate,amount,stage,auth=headers)=>request('/api/crm',{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'save',kind:'deals',data:{name:'Fictional report boundary '+label,closeDate,amount,stage}})});
  for(const [label,day,amount,stage,created,auth] of [
    ['from',filter.value,2.01,'Closed won','2042-12-30T00:00:00Z',headers],
    ['through',filter.valueTo,3.02,'Closed lost','2042-12-31T23:59:59.999999Z',headers],
    ['outside','2043-01-06',4.04,'Closed won','2043-01-01T00:00:00Z',headers],
    ['before','2043-01-01',4.04,'Closed won','2042-12-29T23:59:59.999999Z',headers],
    ['foreign',filter.value,999,'Closed won','2042-12-30T00:00:00Z',other],
  ]){
    const response=await saveDeal(label,day,amount,stage,auth);
    assert.equal(response.status,201);
    const {record}=await response.json();
    await sql`UPDATE deals SET created_at=${created}::timestamptz WHERE id=${record.id}`;
  }
  const filtered=await result(datedPipeline);
  assert.deepEqual([filtered.total,filtered.count,filtered.rows.length],['5.03','2',2]);
  const onlyStart=await result({...datedPipeline,filter:{...filter,valueTo:filter.value}});
  assert.deepEqual([onlyStart.total,onlyStart.count],['2.01','1']);
  const foreignFiltered=await result(datedPipeline,other);
  assert.deepEqual([foreignFiltered.total,foreignFiltered.count],['999','1']);
  const dateOnly={...pipeline,createdDateRange};
  const dateOnlyResult=await result(dateOnly);
  assert.deepEqual([dateOnlyResult.total,dateOnlyResult.count],['5.03','2']);
  const throughOnly=await result({...dateOnly,createdDateRange:{...createdDateRange,from:createdDateRange.through}});
  assert.deepEqual([throughOnly.total,throughOnly.count],['3.02','1']);
  const dateCsv=await exportReport(request,headers,origin,{definition:dateOnly});
  assert.equal(dateCsv.status,200);
  assert.equal(await dateCsv.text(),['"Deal stage","Total deal amount","Records"',...expectedRows(dateOnlyResult,true,true),''].join('\r\n'));
  const dateAndOutcome={...wonInRange,createdDateRange};
  const matching=await result(dateAndOutcome);
  assert.deepEqual([matching.total,matching.count,matching.rows.map(row=>row.label)],['2.01','1',['Closed won']]);
  const noMatches=await result({...dateAndOutcome,createdDateRange:{...createdDateRange,from:createdDateRange.through}});
  assert.deepEqual(noMatches,{total:null,count:'0',rows:[],truncated:false});
  const lostInRange=await result({...datedPipeline,dealOutcome:'lost'});
  assert.deepEqual([lostInRange.total,lostInRange.count],['3.02','1']);
  const wonWithoutDate=await result({...pipeline,dealOutcome:'won'});
  const [expectedWon]=await sql`SELECT sum((data->>'amount')::numeric)::text AS amount, count(*)::text AS count
    FROM deals d WHERE workspace_id=${workspaceId} AND (
      (pipeline_id IS NULL AND data->>'stage'='Closed won') OR EXISTS (
        SELECT 1 FROM deal_pipeline_stages s WHERE s.workspace_id=d.workspace_id AND s.pipeline_id=d.pipeline_id
          AND s.id=d.stage_id AND s.outcome='won'
      ))`;
  assert.deepEqual([wonWithoutDate.total,wonWithoutDate.count],[expectedWon.amount,expectedWon.count]);
  const ungroupedWon=await exportReport(request,headers,origin,{definition:{...pipeline,groupBy:'',dealOutcome:'won'}});
  assert.equal(ungroupedWon.status,200);
  assert.equal(await ungroupedWon.text(),['"Group","Total deal amount","Records"',
    ...expectedRows({...wonWithoutDate,rows:[]},true,true),''].join('\r\n'));
  const foreignWon=await result(dateAndOutcome,other);
  assert.deepEqual([foreignWon.total,foreignWon.count],['999','1']);
  const create=await post({action:'report',definition:pipeline});
  assert.equal(create.status,201,await create.clone().text());
  const {item}=await create.json();
  assert.equal(item.revision,1);
  assert.deepEqual(item.definition,pipeline);
  const byId='?id='+item.id;
  assert.equal((await get(byId,other)).status,404);
  assert.deepEqual(await (await get('',other)).json(),{items:[],next:null});
  const update={action:'report',id:item.id,revision:1,definition:{...dateAndOutcome,dealPipelineId:'default',dealStageId:'Closed won',name:'Fictional saved amount'}};
  assert.equal((await post(update,other)).status,404);
  const requests=await Promise.all([post(update),post(update)]);
  assert.deepEqual(requests.map(response=>response.status).sort(),[200,409]);
  const {item:saved}=await requests.find(response=>response.status===200).json();
  assert.equal(saved.revision,2);
  assert.equal(saved.definition.dealPipelineId,'default');
  assert.equal(saved.definition.dealStageId,'Closed won');
  assert.equal((await exportReport(request,other,origin,{id:saved.id,revision:saved.revision})).status,404);
  assert.equal((await exportReport(request,headers,origin,{id:saved.id,revision:1})).status,409);
  assert.equal((await exportReport(request,headers,origin,{id:saved.id,revision:saved.revision,definition:pipeline})).status,400);
  const savedCsv=await exportReport(request,headers,origin,{id:saved.id,revision:saved.revision});
  assert.equal(savedCsv.status,200);
  assert.equal(await savedCsv.text(),['"Deal stage","Total deal amount","Records"',...expectedRows(matching,true,true),''].join('\r\n'));
  assert.deepEqual(await (await get(byId)).json(),{item:saved});
  const page=await request('/?view=reports&reportId='+saved.id,{headers});
  assert.equal(page.status,200);
  const reportHtml=await page.text();
  assert.match(reportHtml,/Fictional saved amount results/);
  assert.match(reportHtml,/>Export CSV</);
  assert.match(reportHtml,/Close date from 2043-01-02 through 2043-01-05/);
  assert.match(reportHtml,/Create date from 2042-12-30 through 2042-12-31 \(UTC\)/);
  assert.match(reportHtml,/Deal pipeline filter[\s\S]*<option value="default" selected="">Sales pipeline<\/option>/);
  assert.match(reportHtml,/Deal stage filter[\s\S]*<option value="Closed won" selected="">Closed won<\/option>/);
  assert.match(reportHtml.replaceAll('<!-- -->',''),/Deal pipeline is Sales pipeline/);
  assert.match(reportHtml.replaceAll('<!-- -->',''),/Deal outcome is Closed won/);
  assert.match(reportHtml,/Matching records/);
  assert.equal((await request('/?view=reports&reportId='+saved.id,{headers:other})).status,404);

  const another=await post({action:'report',definition:{name:'Temporary report',kind:'contacts'}});
  assert.equal(another.status,201);
  const {item:temporary}=await another.json();
  const first=await (await get('?view=library&limit=1')).json();
  assert.equal(first.next,first.items[0].id);
  const last=await (await get('?view=library&limit=1&after='+first.next)).json();
  assert.equal(last.next,null);
  assert.equal(last.items.length,1);
  assert.notEqual(first.items[0].id,last.items[0].id);
  const remove={action:'deleteReport',id:temporary.id,revision:1};
  assert.equal((await post({...remove,revision:2})).status,409);
  assert.equal((await post(remove)).status,200);
  assert.equal((await get('?id='+temporary.id)).status,404);
  await verifyReportCatalog({request,origin,headers,other,sql,workspaceId});
  const savedResult=await result(saved.definition);
  assert.deepEqual(savedResult,matching);
  for(const report of leadTicketReports){
    const create=await post({action:'report',definition:report.definition});
    assert.equal(create.status,201,await create.clone().text());
    const {item}=await create.json();
    assert.deepEqual(await (await get('?id='+item.id)).json(),{item});
    assert.equal((await get('?id='+item.id,other)).status,404);
    const rendered=await request('/?view=reports&reportId='+item.id,{headers});
    assert.equal(rendered.status,200);
    const html=(await rendered.text()).replaceAll('<!-- -->','');
    assert.ok(html.includes(report.groupLabel+' filter'));
    assert.ok(html.includes(report.groupLabel+' is '+report.definition.filter.value));
    const source={id:item.id,revision:item.revision};
    const download=await exportReport(request,headers,origin,source);
    assert.equal(download.status,200);
    assert.equal(await download.text(),[quote(report.groupLabel)+',"Record count"',...expectedRows(report.result,false,true),''].join('\r\n'));
    assert.equal((await exportReport(request,other,origin,source)).status,404);
    report.item=item;
  }

  await resetBudgets();
  const ticketDay='2052-07-12';
  const ticketCategory='Product question';
  for(const [ticketStatus,ticketPriority,ticketSource,category,auth,day=ticketDay] of [
    ['Waiting on us','Urgent','Email',ticketCategory],['Waiting on us','Urgent','Phone',ticketCategory],
    ['Waiting on us','High','Email',ticketCategory],['Closed','Urgent','Email',ticketCategory],
    ['Waiting on us','Urgent','Email','Billing'],['Waiting on us','Urgent','Email'],
    ['Waiting on us','Urgent','Email',ticketCategory,other],
    ['Waiting on us','Urgent','Email',ticketCategory,headers,'2052-07-13'],
  ]){
    const response=await createRecord('tickets',{name:'Fictional ticket filter sample',ticketStatus,ticketPriority,ticketSource,ticketCategory:category},auth);
    assert.equal(response.status,201,await response.clone().text());
    const {record}=await response.json();
    await sql`UPDATE portable_tickets SET created_at=${day+'T12:00:00Z'} WHERE id=${record.id}`;
  }
  const categoryOnly={name:'Fictional product questions',kind:'tickets',ticketCategory};
  const categoryResult=await result(categoryOnly);
  assert.deepEqual(categoryResult,{total:'5',count:'5',truncated:false,rows:[]});
  const categoryCsv=await exportReport(request,headers,origin,{definition:categoryOnly});
  assert.equal(categoryCsv.status,200);
  assert.equal(await categoryCsv.text(),['"Group","Record count"',...expectedRows(categoryResult,false,true),''].join('\r\n'));
  const priorityOnly={name:'Fictional priority-only tickets',kind:'tickets',ticketPriority:'Urgent'};
  const priorityResult=await result(priorityOnly);
  assert.ok(Number(priorityResult.count)>=3);
  const priorityCsv=await exportReport(request,headers,origin,{definition:priorityOnly});
  assert.equal(priorityCsv.status,200);
  assert.equal(await priorityCsv.text(),['"Group","Record count"',...expectedRows(priorityResult,false,true),''].join('\r\n'));
  const reportResponse=await post({action:'report',definition:priorityOnly});
  assert.equal(reportResponse.status,201,await reportResponse.clone().text());
  const {item:priorityReport}=await reportResponse.json();
  const priorityPage=await request('/?view=reports&reportId='+priorityReport.id,{headers});
  assert.equal(priorityPage.status,200);
  const priorityHtml=(await priorityPage.text()).replaceAll('<!-- -->','');
  assert.match(priorityHtml,/Ticket priority is Urgent/);
  assert.match(priorityHtml,/<th scope="row">Matching records<\/th>/);
  const ticketDefinition={...priorityOnly,name:'Fictional urgent email tickets',groupBy:'ticketStatus',ticketSource:'Email',ticketCategory,
    filter:{field:'ticketStatus',operator:'eq',value:'Waiting on us'},createdDateRange:{from:ticketDay,through:ticketDay}};
  const updated=await post({action:'report',id:priorityReport.id,revision:priorityReport.revision,definition:ticketDefinition});
  assert.equal(updated.status,200,await updated.clone().text());
  const {item:ticketReport}=await updated.json();
  assert.deepEqual(await (await get('?id='+ticketReport.id)).json(),{item:ticketReport});
  assert.equal((await get('?id='+ticketReport.id,other)).status,404);
  const ticketResult=await result(ticketReport.definition);
  assert.deepEqual(ticketResult,{total:'1',count:'1',truncated:false,
    rows:[{key:'Waiting on us',label:'Waiting on us',count:'1',value:'1'}]});
  const ticketCsv=await exportReport(request,headers,origin,{id:ticketReport.id,revision:ticketReport.revision});
  assert.equal(ticketCsv.status,200);
  assert.equal(await ticketCsv.text(),['"Ticket status","Record count"',...expectedRows(ticketResult,false,true),''].join('\r\n'));
  const ticketPage=await request('/?view=reports&reportId='+ticketReport.id,{headers});
  assert.equal(ticketPage.status,200);
  const ticketHtml=(await ticketPage.text()).replaceAll('<!-- -->','');
  assert.match(ticketHtml,/name="ticketPriority"[^>]*>[\s\S]*?<option value="Urgent" selected="">Urgent<\/option>/);
  assert.match(ticketHtml,/name="ticketSource"[^>]*>[\s\S]*?<option value="Email" selected="">Email<\/option>/);
  assert.match(ticketHtml,/name="ticketCategory"[^>]*>[\s\S]*?<option value="Product question" selected="">Product question<\/option>/);
  assert.match(ticketHtml,/Ticket category is Product question/);
  assert.match(ticketHtml,/Ticket priority is Urgent/);
  assert.match(ticketHtml,/Ticket source is Email/);
  const dashboard=await post({action:'dashboard',
    definition:{name:'Fictional support dashboard',cards:[{reportId:ticketReport.id,wide:false}]}});
  assert.equal(dashboard.status,201,await dashboard.clone().text());
  const {item:ticketDashboard}=await dashboard.json();
  const dashboardPath='?view=dashboard&id='+ticketDashboard.id;
  const dashboardRead=await get(dashboardPath);
  assert.equal(dashboardRead.status,200);
  const {cards}=await dashboardRead.json();
  assert.deepEqual(cards[0].definition,ticketReport.definition);
  assert.deepEqual(cards[0].result,ticketResult);
  assert.equal((await get(dashboardPath,other)).status,404);
  assert.equal((await post({action:'deleteDashboard',id:ticketDashboard.id,revision:ticketDashboard.revision})).status,200);
  leadTicketReports.push({item:ticketReport,result:ticketResult,groupLabel:'Ticket status'});

  await resetBudgets();
  for(const [label,dueDate,status,auth] of [
    ['Before','2051-04-09'],['First','2051-04-10'],['Last','2051-04-12'],['After','2051-04-13'],
    ['Undated',''],['Done','2051-04-11','Completed'],['Archived','2051-04-11'],['Foreign','2051-04-11','Not started',other],
  ]){
    const assigneeId=label==='Foreign'?otherIdentity.id:
      ['First','Done','Archived'].includes(label)?ownerIdentity.id:undefined;
    const created=await request('/api/crm',{method:'POST',headers:{...(auth??headers),origin,'content-type':'application/json'},
      body:JSON.stringify({action:'save',kind:'tasks',assigneeId,data:{name:'Fictional due report '+label,dueDate,status}})});
    assert.equal(created.status,201,await created.clone().text());
    if(label==='Archived'){
      const {record}=await created.json();
      const archived=await request('/api/recycle-bin',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
        body:JSON.stringify({kind:'tasks',action:'archive',id:record.id,expectedRevision:record.revision,requestId:randomUUID()})});
      assert.equal(archived.status,200,await archived.clone().text());
    }
  }
  assert.equal((await result(dueDefinition)).count,'3');
  assert.equal((await result(dueDefinition,other)).count,'1');
  assert.equal((await result({...dueDefinition,taskAssigneeId:ownerIdentity.id})).count,'2');
  assert.equal((await result({...dueDefinition,taskAssigneeId:ownerIdentity.id},other)).count,'0');
  assert.equal((await result({...dueDefinition,taskAssigneeId:otherIdentity.id})).count,'0');
  assert.equal((await result({...dueDefinition,taskAssigneeId:otherIdentity.id},other)).count,'1');
  assert.equal((await result({...dueDefinition,taskAssigneeId:null})).count,'1');
  const definition={...dueDefinition,filter:{field:'status',operator:'eq',value:'Not started'},
    createdDateRange:{from:'2000-01-01',through:'2050-12-31'},taskAssigneeId:ownerIdentity.id};
  const dueResult=await result(definition);
  assert.deepEqual(dueResult,{total:'1',count:'1',rows:[],truncated:false});
  const dueCsv=await exportReport(request,headers,origin,{definition:dueDefinition});
  assert.equal(dueCsv.status,200);
  assert.match(await dueCsv.text(),/"Matching records","3"/);
  const dueSave=await post({action:'report',definition});
  assert.equal(dueSave.status,201,await dueSave.clone().text());
  const {item:dueReport}=await dueSave.json();
  const duePage=await request('/?view=reports&reportId='+dueReport.id,{headers});
  const dueHtml=await duePage.text();
  assert.match(dueHtml,/Due date filter/);
  assert.match(dueHtml,/name="dueFrom"[^>]+value="2051-04-10"/);
  assert.match(dueHtml,/Due date from 2051-04-10 through 2051-04-12/);
  assert.match(dueHtml,/Assignee filter/);
  assert.ok(dueHtml.replaceAll('<!-- -->','').includes('Assignee is '+ownerIdentity.label));
  await resetBudgets();
  return {saved,savedResult,leadTicketReports,dueReport,dueResult,dueAssigneeLabel:ownerIdentity.label};
}

export async function verifyRestoredPortableReport({request,origin,owner,other,reports}){
  const {saved,savedResult,leadTicketReports,dueReport,dueResult}=reports;
  const url=path+'?id='+saved.id;
  assert.deepEqual(await (await request(url,{headers:owner})).json(),{item:saved});
  assert.equal((await request(url,{headers:other})).status,404);
  const rendered=await request('/?view=reports&reportId='+saved.id,{headers:owner});
  assert.equal(rendered.status,200);
  const html=(await rendered.text()).replaceAll('<!-- -->','');
  assert.match(html,/Fictional saved amount results/);
  assert.match(html,/Deal outcome is Closed won/);
  assert.match(html,/Deal pipeline is Sales pipeline/);
  assert.match(html,/Create date from 2042-12-30 through 2042-12-31 \(UTC\)/);
  const evaluated=await preview(request,owner,origin,saved.definition);
  assert.equal(evaluated.status,200);
  assert.deepEqual((await evaluated.json()).result,savedResult);
  const download=await exportReport(request,owner,origin,{id:saved.id,revision:saved.revision});
  assert.equal(download.status,200);
  assert.equal(await download.text(),['"Deal stage","Total deal amount","Records"',...expectedRows(savedResult,true,true),''].join('\r\n'));
  assert.equal((await exportReport(request,other,origin,{id:saved.id,revision:saved.revision})).status,404);
  for(const {item,result,groupLabel} of leadTicketReports){
    const url=path+'?id='+item.id;
    assert.deepEqual(await (await request(url,{headers:owner})).json(),{item});
    assert.equal((await request(url,{headers:other})).status,404);
    const evaluated=await preview(request,owner,origin,item.definition);
    assert.equal(evaluated.status,200);
    assert.deepEqual((await evaluated.json()).result,result);
    const source={id:item.id,revision:item.revision};
    const download=await exportReport(request,owner,origin,source);
    assert.equal(download.status,200);
    assert.equal(await download.text(),[quote(groupLabel)+',"Record count"',...expectedRows(result,false,true),''].join('\r\n'));
    assert.equal((await exportReport(request,other,origin,source)).status,404);
  }
  assert.deepEqual(await (await request(path+'?id='+dueReport.id,{headers:owner})).json(),{item:dueReport});
  assert.equal((await request(path+'?id='+dueReport.id,{headers:other})).status,404);
  const due=await preview(request,owner,origin,dueReport.definition);
  assert.equal(due.status,200);
  assert.deepEqual((await due.json()).result,dueResult);
  const dueCsv=await exportReport(request,owner,origin,{id:dueReport.id,revision:dueReport.revision});
  assert.equal(dueCsv.status,200);
  assert.match(await dueCsv.text(),/"Matching records","1"/);
}
