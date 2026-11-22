import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyInquirySearch({request,headers,other,origin,sql}){
  const api='/api/lead-forms';
  async function createForm(title,auth){
    const id=randomUUID();
    const response=await request(api,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'save',id,revision:0,definition:{title,description:'',thankYou:'Thanks',
        embedOrigin:'https://fictional.example.test',captureContacts:false,queueWorkflows:false}})});
    assert.ok(response.ok,await response.clone().text());
    return id;
  }
  const form=await createForm('Product demo',headers),alternate=await createForm('Support',headers);
  const foreign=await createForm('Other workspace',other);
  const workspace=async auth=>{
    const response=await request('/api/workspaces',{headers:auth});
    assert.equal(response.status,200);
    return (await response.json()).owned;
  };
  const mine=await workspace(headers),theirs=await workspace(other);
  const read=async(params,auth=headers)=>{
    const response=await request(api+'?'+new URLSearchParams(params),{headers:auth});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const indexName='portable_lead_inquiries_search';
  const [index]=await sql`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=${indexName}`;
  assert.ok(index);
  await sql`DROP INDEX portable_lead_inquiries_search`;
  await sql`INSERT INTO portable_lead_inquiries(workspace_id,id,form_id,received_at,payload,status,handled)
    SELECT ${mine},gen_random_uuid(),${form},i+1000,
      jsonb_build_object('name',CASE WHEN i=1 THEN 'QxxAref' ELSE 'Visitor '||i END,'email','visitor-'||i||'@example.test'),'inbox_only',true
    FROM generate_series(1,70000) i`;
  const marker='Cobalt',literal='Q%_A\\ref';
  const ids=[];
  for(let i=0;i<30;i++){
    const id=randomUUID(),space=i===29?theirs:mine,formId=i===29?foreign:i===28?alternate:form;
    const payload=i===0?{name:'Cobalt '+literal,email:'first@example.test'}:
      {name:'Follow-up '+i,email:'cobalt-'+i+'@example.test'};
    await sql`INSERT INTO portable_lead_inquiries(workspace_id,id,form_id,received_at,payload,status,handled)
      VALUES(${space},${id},${formId},1,${sql.json(payload)},'inbox_only',${i===1})`;
    ids.push(id);
  }
  // Same timestamp makes the second page depend on the ID part of the cursor.
  const query={inquiries:'workspace',filter:'all',inquirySearch:'COBALT'};
  async function measure(params,matching){
    const times=[],expected=matching.slice().sort().reverse();
    for(let pass=0;pass<6;pass++){
      const start=performance.now();
      const page=await read(params);
      if(pass)times.push(performance.now()-start);
      assert.deepEqual(page.results.map(row=>row.id),expected.slice(0,25));
      if(!pass){
        const next=await read({...params,afterAt:String(page.next.at),afterId:page.next.id});
        assert.deepEqual(next.results.map(row=>row.id),expected.slice(25));assert.equal(next.next,null);
      }
    }
    return Math.round(times.sort((a,b)=>a-b)[2]);
  }
  await sql`ANALYZE portable_lead_inquiries`;
  const matching=ids.slice(0,29);
  const before=await measure(query,matching);
  await sql.unsafe(index.indexdef);
  const after=await measure(query,matching);
  const open={inquiries:'workspace'};
  const openIds=matching.filter(id=>id!==ids[1]);
  const [queueIndex]=await sql`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='portable_lead_inquiries_open_page'`;
  await sql`DROP INDEX portable_lead_inquiries_open_page`;
  const beforeQueue=await measure(open,openIds);
  await sql.unsafe(queueIndex.indexdef);
  const afterQueue=await measure(open,openIds);
  console.log('Open inquiries behind 70,000 handled submissions, median of five HTTP reads:',beforeQueue,'to',afterQueue,'ms');
  const absent=await read({...query,inquirySearch:marker+'-missing'});
  assert.deepEqual(absent.results,[]);
  assert.deepEqual((await read({...query,inquirySearch:literal.toLowerCase()})).results.map(r=>r.id),[ids[0]]);
  assert.deepEqual((await read({...query,filter:'handled'})).results.map(r=>r.id),[ids[1]]);
  assert.deepEqual((await read({formId:alternate,inquirySearch:marker})).results.map(r=>r.id),[ids[28]]);
  assert.deepEqual((await read(query,other)).results.map(r=>r.id),[ids[29]]);
  const forbidden=await request(api+'?'+new URLSearchParams({formId:form,inquirySearch:marker}),{headers:other});
  assert.equal(forbidden.status,404);
  const scopedOpen={formId:alternate,filter:'open'};
  async function change(body){
    const result=await request(api,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.ok(result.ok,await result.clone().text());
  }
  const triage={action:'setInquiryHandled',formId:alternate,submissionId:ids[28]};
  await change({...triage,handled:true,triageRevision:0});
  assert.deepEqual((await read(scopedOpen)).results,[]);
  await change({...triage,handled:false,triageRevision:1});
  assert.deepEqual((await read(scopedOpen)).results.map(r=>r.id),[ids[28]]);
  await change({action:'removeInquiry',formId:form,submissionId:ids[0]});
  assert.deepEqual((await read({...query,inquirySearch:literal})).results,[]);
  const [size]=await sql`SELECT pg_size_pretty(pg_relation_size(${indexName}::regclass)) space`;
  console.log('Inquiry search, 70,000 background submissions, median of five HTTP reads:',before,'to',after,'ms. Index:',size.space);
  for(let attempt=0;attempt<12;attempt++){
    const usage=await sql`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname IN (${indexName},'portable_lead_inquiries_open_page')`;
    if(usage.length===2&&usage.every(row=>Number(row.idx_scan)>0))return;
    await new Promise(resolve=>setTimeout(resolve,200));
    await read(query);
    await read(open);
  }
  assert.fail('The Forms endpoint did not use both inquiry indexes.');
}
