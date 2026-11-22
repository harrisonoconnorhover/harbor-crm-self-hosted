import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPortableBoard({request,origin,headers,other,sql,sharing}){
  const {pipeline,pipelineDeal}=sharing;
  const [stage]=pipeline.stages;
  const ids=Array.from({length:10},()=>randomUUID()).sort();
  await sql`INSERT INTO deals(workspace_id,id,revision,pipeline_id,stage_id,data,created_at,updated_at)
    SELECT ${sharing.workspaceId}, id, 1, ${pipeline.id}, ${stage.id},
      jsonb_build_object('name','Board fixture '||position,'stage',${stage.name}::text,'amount',10.15,
        'closeDate',CASE WHEN position<=9 THEN '2026-12-31' ELSE '2027-01-01' END),
      now(),now()
    FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS rows(id,position)`;
  const path='/?kind=deals&view=board&pipelineId='+pipeline.id;
  const shared=path+'&workspaceId='+sharing.workspaceId;
  const get=(url,auth)=>request(url,{headers:auth});
  assert.equal((await get(path,{})).status,307);
  assert.equal((await get(path,other)).status,404);
  const own=await get(path,headers);
  assert.equal(own.status,200);
  const html=await own.text();
  assert.match(html,/aria-label="Account expansion board"/);
  assert.match(html,/aria-label="Qualify expansion"/);
  assert.match(html,/Board fixture 8</);
  assert.doesNotMatch(html,/Board fixture (9|10)</);
  assert.match(html.replaceAll('<!-- -->',''),/View all deals in Qualify expansion/);
  assert.doesNotMatch(html,/Owner Deal</);
  const builtin=await get('/?kind=deals&view=board',headers);
  assert.equal(builtin.status,200);
  const builtinHtml=await builtin.text();
  assert.match(builtinHtml,/aria-label="Sales pipeline board"/);
  assert.match(builtinHtml,/Owner Deal</);
  assert.doesNotMatch(builtinHtml,/Board fixture 1</);
  const laneList='/api/crm?kind=deals&pipelineId='+pipeline.id+'&stage='+stage.id;
  const {records}=await (await get(laneList,headers)).json();
  assert.deepEqual(records.map(row=>row.id),ids);

  const summaryPath='/?kind=deals&view=summary&pipelineId='+pipeline.id;
  const month='&closeMonth=2026-12';
  const scoped='&workspaceId='+sharing.workspaceId;
  assert.equal((await get(summaryPath+month,{})).status,307);
  assert.equal((await get(summaryPath+month,other)).status,404);
  assert.equal((await get(summaryPath+'&closeMonth=2026-13',headers)).status,404);
  assert.equal((await get(laneList+'&closeMonth=2026-13',headers)).status,400);
  const report=await get(summaryPath+month,headers);
  assert.equal(report.status,200);
  const reportHtml=(await report.text()).replaceAll('<!-- -->','');
  assert.match(reportHtml,/Deals closing in 2026-12/);
  assert.match(reportHtml,/Qualify expansion<\/a><\/th><td>Open<\/td><td>9<\/td><td>91\.35<\/td><td>35%<\/td><td>31\.97<\/td>/);
  assert.match(reportHtml,/<tfoot><tr><th[^>]*>Total<\/th><td>9<\/td><td>91\.35<\/td><td>—<\/td><td>31\.97<\/td>/);
  assert.doesNotMatch(reportHtml,/Board fixture 1|Editor expansion deal/);
  const allHtml=(await (await get(summaryPath,headers)).text()).replaceAll('<!-- -->','');
  assert.match(allHtml,/<tfoot><tr><th[^>]*>Total<\/th><td>11<\/td><td>601\.50<\/td><td>—<\/td><td>35\.53<\/td>/);
  const undatedHtml=(await (await get(summaryPath+'&closeMonth=undated',headers)).text()).replaceAll('<!-- -->','');
  assert.match(undatedHtml,/Renewed<\/a><\/th><td>Won<\/td><td>1<\/td><td>500\.00<\/td><td>100%<\/td><td>—<\/td>/);
  const emptyHtml=(await (await get(summaryPath+'&closeMonth=2026-11',headers)).text()).replaceAll('<!-- -->','');
  assert.match(emptyHtml,/<tfoot><tr><th[^>]*>Total<\/th><td>0<\/td><td>0\.00<\/td><td>—<\/td><td>0\.00<\/td>/);
  const december=await (await get(laneList+month+'&limit=8',headers)).json();
  const following=await (await get(laneList+month+'&limit=8&after='+december.next,headers)).json();
  assert.deepEqual([...december.records,...following.records].map(row=>row.id),ids.slice(0,9));
  assert.equal(following.next,null);

  const edit=await get(shared,other);
  assert.equal(edit.status,200);
  assert.match(await edit.text(),/aria-label="Move Board fixture 1 to stage"/);
  const moveUrl='/api/crm?workspaceId='+sharing.workspaceId+'&grantId=';
  const write=(grantId,data)=>request(moveUrl+grantId,{method:'POST',headers:{...other,origin,'content-type':'application/json'},
    body:JSON.stringify(data)});
  const payload={action:'save',kind:'deals',id:pipelineDeal.id,expectedRevision:pipelineDeal.revision-1,
    data:pipelineDeal.data,stageId:stage.id};
  assert.equal((await write(sharing.grantId,payload)).status,409);
  const role=async(next)=>{
    const response=await request('/api/workspaces',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'role',id:sharing.grantId,role:next})});
    assert.equal(response.status,200);
    sharing.grantId=(await response.json()).viewers[0].id;
  };
  await role('viewer');
  const viewer=await get(shared,other);
  assert.equal(viewer.status,200);
  const viewerHtml=await viewer.text();
  const viewCard=viewerHtml.match(/<a[^>]*class="portable-deal-card-title" href="([^"]+)"[^>]*>Board fixture 1<\/a>/)?.[1];
  assert.ok(viewCard);
  const viewCardParams=new URL(viewCard.replaceAll('&amp;','&'),origin).searchParams;
  const back=new URL(viewCardParams.get('back'),origin);
  assert.equal(back.searchParams.get('workspaceId'),sharing.workspaceId);
  assert.equal(back.searchParams.get('view'),'board');
  viewCardParams.delete('back');
  assert.deepEqual([...viewCardParams].sort(),Object.entries({
    kind:'deals',record:ids[0],workspaceId:sharing.workspaceId,
  }).sort());
  assert.doesNotMatch(viewerHtml,/aria-label="Move Board fixture 1 to stage"/);
  const sharedSummary=await get(summaryPath+month+scoped,other);
  assert.equal(sharedSummary.status,200);
  const summaryHtml=await sharedSummary.text();
  assert.match(summaryHtml.replaceAll('<!-- -->',''),/<tfoot><tr><th[^>]*>Total<\/th><td>9<\/td><td>91\.35<\/td><td>—<\/td><td>31\.97<\/td>/);
  const drillDown=summaryHtml.match(/href="([^"]+)">Qualify expansion<\/a>/)?.[1].replaceAll('&amp;','&');
  assert.ok(drillDown);
  const drillParams=new URL(drillDown,origin).searchParams;
  assert.deepEqual([drillParams.get('workspaceId'),drillParams.get('stage'),drillParams.get('closeMonth')],[sharing.workspaceId,stage.id,'2026-12']);
  const signIn=await get(drillDown,{});
  assert.equal(signIn.status,307);
  const returnTo=new URL(signIn.headers.get('location'),origin).searchParams.get('return_to');
  assert.ok(returnTo);
  const resumed=new URL(returnTo,origin).searchParams;
  assert.deepEqual([...resumed].sort(),[...drillParams].sort());
  const drillPage=await get(drillDown,other);
  assert.equal(drillPage.status,200);
  const drillHtml=await drillPage.text();
  assert.match(drillHtml,/Board fixture 9/);
  assert.doesNotMatch(drillHtml,/Board fixture 10/);

  assert.equal((await write(sharing.grantId,{...payload,expectedRevision:pipelineDeal.revision})).status,403);
  const literal=String.raw`Search %_\ fixture`;
  const query=new URLSearchParams({kind:'deals',workspaceId:sharing.workspaceId,pipelineId:pipeline.id,stage:stage.id,
    closeMonth:'2027-01',search:literal.toUpperCase()});
  const matches=Array.from({length:26},()=>randomUUID()).sort();
  const distractor=randomUUID();
  try{
    await sql`INSERT INTO deals(workspace_id,id,revision,pipeline_id,stage_id,data,created_at,updated_at)
      SELECT ${sharing.workspaceId}, id, 1, ${pipeline.id}, ${stage.id},
        jsonb_build_object('name',CASE WHEN id=${distractor}::uuid THEN 'Search xyz fixture'
          ELSE ${literal}::text||' '||position END,'stage',${stage.name}::text,'amount',0,'closeDate','2027-01-02'),
        now(),now()
      FROM unnest(${[...matches,distractor]}::uuid[]) WITH ORDINALITY AS rows(id,position)`;
    const found=await get('/?'+query,other);
    assert.equal(found.status,200);
    const foundHtml=await found.text();
    assert.doesNotMatch(foundHtml,/Search xyz fixture|Board fixture 10/);
    const next=foundHtml.match(/href="([^"]+)">Next page<\/a>/)?.[1].replaceAll('&amp;','&');
    assert.ok(next);
    const nextQuery=new URL(next,origin).searchParams;
    assert.equal(nextQuery.get('after'),matches[24]);
    nextQuery.delete('after');
    assert.deepEqual([...nextQuery].sort(),[...query].sort());
    const pageTwo=await get(next,other);
    assert.equal(pageTwo.status,200);
    assert.match(await pageTwo.text(),/Search %_\\ fixture 26/);
    const result=await (await get('/api/crm?'+query+'&limit=1',other)).json();
    assert.equal(result.records[0].id,matches[0]);
    assert.equal(result.next,matches[0]);
    const ownSearch=new URLSearchParams(query);
    ownSearch.delete('workspaceId');
    assert.deepEqual((await (await get('/api/crm?'+ownSearch,other)).json()).records,[]);
    const boardQuery=new URLSearchParams(query);
    boardQuery.delete('stage');
    boardQuery.set('view','board');
    boardQuery.set('owner','unassigned');
    const filteredBoard=await get('/?'+boardQuery,other);
    assert.equal(filteredBoard.status,200);
    const filteredBoardHtml=(await filteredBoard.text()).replaceAll('<!-- -->','');
    assert.equal([...filteredBoardHtml.matchAll(/<a[^>]*class="portable-deal-card-title"[^>]*>Search %_\\ fixture \d+<\/a>/g)].length,8);
    assert.doesNotMatch(filteredBoardHtml,/Search xyz fixture|Board fixture 10/);
    const overflow=filteredBoardHtml.match(/href="([^"]+)">View all deals in Qualify expansion<\/a>/)?.[1].replaceAll('&amp;','&');
    assert.ok(overflow);
    const listQuery=new URL(overflow,origin).searchParams;
    boardQuery.delete('view');
    boardQuery.set('stage',stage.id);
    assert.deepEqual([...listQuery].sort(),[...boardQuery].sort());
  }finally{
    await sql`DELETE FROM deals WHERE workspace_id=${sharing.workspaceId} AND id=ANY(${[...matches,distractor]}::uuid[])`;
  }
  await role('editor');
}
