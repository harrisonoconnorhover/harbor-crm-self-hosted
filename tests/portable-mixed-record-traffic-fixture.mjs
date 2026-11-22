import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

export async function verifyMixedRecordTraffic({request,origin,sql,readers,readList,workspaceId,byRep}){
  const owner=readers[0],reps=readers.filter(reader=>reader.scope==='owned');
  const raceRep=reps[0],removed=reps.at(-1);
  const directory=await sql`SELECT u.email, m.id FROM portable_workspace_viewers m
    JOIN login_identities u ON u.id=m.viewer_id WHERE m.workspace_id=${workspaceId}`;
  const grants=new Map(directory.map(row=>[row.email,row.id]));
  const history=new Map(reps.map(rep=>[rep.email,[]]));
  const timings={read:[],write:[]};
  async function post(path,auth,body){
    return request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  }
  function save(reader,rep,revision,title){
    const path=reader===owner?'/api/crm':'/api/crm?'+new URLSearchParams({workspaceId,grantId:grants.get(reader.email)});
    return post(path,reader.auth,{action:'save',kind:'contacts',id:byRep.get(rep.email),expectedRevision:revision,
      data:{name:'Quarterly follow-up',title}});
  }
  async function write(reader,rep,round,racing){
    const email=reader===owner?'owner@example.test':reader.email;
    const edits=history.get(rep.email),title='Follow-up '+round+' from '+email;
    // Both contenders have opened the same revision before either response is available.
    const revision=edits.length+1;
    const response=await save(reader,rep,revision,title);
    const body=await response.json();
    if(racing&&response.status===409){
      assert.equal(body.code,'stale_revision');
      return 'conflict';
    }
    assert.equal(response.status,200,JSON.stringify(body));
    assert.equal(body.record.id,byRep.get(rep.email));
    assert.equal(body.record.revision,revision+1);
    assert.equal(body.record.data.title,title);
    edits.push({email,title,revision:revision+1});
    return 'saved';
  }
  const start=performance.now(),rounds=32,interval=2000,revokeAt=16,raceAt=8;
  for(let round=0;round<rounds;round++){
    await delay(Math.max(0,start+round*interval-performance.now()));
    if(round===revokeAt){
      const response=await post('/api/workspaces',owner.auth,{action:'revoke',id:grants.get(removed.email)});
      assert.equal(response.status,200,await response.text());
    }
    const results=await Promise.all(readers.map(async(reader,i)=>{
      const sent=performance.now();
      if(round>=revokeAt&&reader===removed){
        const response=round%2===0
          ?await request('/api/crm?'+new URLSearchParams({kind:'contacts',workspaceId,id:byRep.get(removed.email)}),{headers:reader.auth})
          :await save(removed,removed,history.get(removed.email).length+1,'Revoked edit');
        assert.equal(response.status,round%2===0?404:403,await response.text());
        return 'denied';
      }
      const racing=round===raceAt&&(reader===owner||reader===raceRep);
      if(racing||reader.scope==='owned'&&(Math.floor(i/2)+round)%2===0){
        const result=await write(reader,racing?raceRep:reader,round,racing);
        if(result==='saved')timings.write.push(performance.now()-sent);
        return result;
      }
      await readList(reader,i+round);
      timings.read.push(performance.now()-sent);
      return 'read';
    }));
    assert.equal(results.filter(item=>item==='conflict').length,round===raceAt?1:0);
    assert.equal(results.filter(item=>item==='denied').length,round>=revokeAt?1:0);
  }
  const elapsed=performance.now()-start;
  const rows=await sql`SELECT c.id,c.revision,c.data->>'title' AS title,
    jsonb_agg(jsonb_build_object('revision',e.revision,'email',u.email,'title',e.data->>'title') ORDER BY e.revision) AS edits
    FROM contacts c JOIN contact_events e ON e.workspace_id=c.workspace_id AND e.contact_id=c.id
    JOIN login_identities u ON u.id=e.actor_id
    WHERE c.workspace_id=${workspaceId} AND c.id=ANY(${[...byRep.values()]}::uuid[])
    GROUP BY c.workspace_id,c.id`;
  const byId=new Map(rows.map(row=>[row.id,row]));
  assert.equal(byId.size,reps.length);
  for(const [email,edits] of history){
    const stored=byId.get(byRep.get(email)),last=edits.at(-1);
    assert.deepEqual(stored.edits,edits);
    assert.equal(stored.revision,last.revision);
    assert.equal(stored.title,last.title);
  }
  const p95=sample=>Math.round(sample.sort((a,b)=>a-b)[Math.ceil(sample.length*.95)-1]);
  console.log('Mixed traffic: '+readers.length+' sessions, '+rounds+' rounds over '+Math.round(elapsed/1000)+' s. '+
    timings.read.length+' searches (p95 '+p95(timings.read)+' ms), '+timings.write.length+
    ' saved edits (p95 '+p95(timings.write)+' ms), 1 stale edit and '+(rounds-revokeAt)+' revoked requests rejected.');
}
