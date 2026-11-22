import {seedMemberSessions} from './portable-member-sessions.mjs';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

export async function verifyInboxScale({read,post,ok,sql,workspaceId,headers,other,configure}){
  const [rep]=await sql`SELECT viewer_id FROM portable_workspace_viewers WHERE workspace_id=${workspaceId}`;
  await sql`INSERT INTO portable_inbox_conversations(workspace_id,id,mailbox,sender,subject,claimed_by,tags,updated_at)
    SELECT ${workspaceId},gen_random_uuid(),CASE WHEN n%5000=0 THEN 'returns@example.test' ELSE 'primary@example.test' END,
      CASE WHEN n=42123 THEN 'service+meridian@example.test' ELSE 'buyer@example.test' END,'Capacity case '||n,CASE WHEN n%5000=0 THEN ${rep.viewer_id} ELSE NULL END,
      CASE WHEN n%5000=0 THEN ARRAY['Replacement','Field kit'] ELSE ARRAY['Setup'] END,
      '2025-01-01'::timestamptz+n*interval '1 second' FROM generate_series(1,70000) n`;
  await sql`INSERT INTO portable_inbox_messages(workspace_id,id,conversation_id,mailbox,direction,state,provider_id,body,created_at)
    SELECT workspace_id,gen_random_uuid(),id,mailbox,'incoming','received',gen_random_uuid()::text,
      CASE WHEN subject='Capacity case 42123' THEN 'Machine serial ZX418 verification' ELSE 'Fictional support question' END,
      CASE WHEN mailbox='returns@example.test' THEN now()-interval '48 hours' ELSE now() END
    FROM portable_inbox_conversations WHERE workspace_id=${workspaceId} AND subject LIKE 'Capacity case %'`;
  await sql`INSERT INTO portable_inbox_messages(workspace_id,id,conversation_id,mailbox,direction,state,actor_id,internet_id,body)
    SELECT workspace_id,gen_random_uuid(),id,mailbox,'outgoing','sent',${rep.viewer_id},id::text,'Fictional resolution'
    FROM portable_inbox_conversations WHERE workspace_id=${workspaceId} AND subject LIKE 'Capacity case %' AND mailbox='primary@example.test'`;
  await sql`VACUUM (ANALYZE) portable_inbox_messages`;
  await sql`VACUUM (ANALYZE) portable_inbox_conversations`;
  const base='/api/team-inbox?workspaceId='+workspaceId;
  for(const [name,filter,count] of [['recent','',25],['mailbox','&mailbox=returns@example.test',14],
    ['waiting 24 hours','&status=needs_reply&waiting=24h&mailbox=returns@example.test',14],
    ['answered mailbox','&status=needs_reply&mailbox=primary@example.test',0],['claim','&claim=mine',15],['named teammate','&claim='+rep.viewer_id,15],['tag','&tag=rEpLaCeMeNt',14],['absent tag','&tag=NeverUsed',0],
    ['subject','&q=case%2042123',1],['sender','&q=Meridian',1],['absent text','&q=unfindable',0],['message body','&messageText=zx418%20SERIAL',1]]){
    const elapsed=[];
    for(let i=0;i<5;i++){
      const start=performance.now();
      const result=await ok(read(base+filter,other));
      elapsed.push(performance.now()-start);
      assert.equal(result.items.length,count,name);
      if(name==='message body')assert.ok(result.items[0].matchingMessageId);
      if(name==='subject'||name==='sender'||name==='message body')assert.equal(result.items[0].subject,'Capacity case 42123');
      if(name==='tag')assert.ok(result.items.every(row=>row.tags.includes('Replacement')));
    }
    const warm=elapsed.slice(1).sort((a,b)=>a-b);
    console.log('Inbox (70,000 added), '+name+', warm median ms:',Math.round((warm[1]+warm[2])/2));
  }

  // The application restarts before the burst, flushing its PostgreSQL index statistics as well.
  const emails=Array.from({length:98},(_,i)=>'inbox-rep-'+i+'@example.test');
  await configure({HARBOR_LOGIN_ALLOWED_EMAILS:['owner@example.test','other@example.test',...emails].join(','),HARBOR_WORKSPACE_SEAT_LIMIT:'100'});
  const used=await sql`SELECT indexrelname,idx_scan FROM pg_stat_user_indexes WHERE indexrelname IN
    ('inbox_conversation_unanswered_page','inbox_conversation_claim_page','inbox_conversation_tag_keys','inbox_conversation_status_page','inbox_conversation_text_search','inbox_message_body_search')`;
  assert.equal(used.length,6);
  for(const index of used)assert.ok(Number(index.idx_scan)>0,index.indexrelname+' unused by the inbox fixture');

  await ok(post('/api/crm',{action:'save',kind:'contacts',data:{name:'Second support team'}},other));
  const {owned:second}=await ok(read('/api/workspaces',other));
  assert.ok(second&&second!==workspaceId);
  await sql`INSERT INTO portable_inbox_conversations(workspace_id,id,mailbox,sender,subject,tags)
    VALUES (${second},gen_random_uuid(),'support-2@example.test','buyer@example.test','Second team replacement',ARRAY['Replacement'])`;
  const spaces=[workspaceId,second];
  const members=await seedMemberSessions(sql,spaces,emails);
  const sessions=[...members,{headers,team:0},{headers:other,team:1}];
  const handoffs=[];
  for(const workspace of spaces){
    const [conversation]=await sql`INSERT INTO portable_inbox_conversations(workspace_id,id,mailbox,sender,subject,tags)
      VALUES (${workspace},gen_random_uuid(),'support@example.test','buyer@example.test','Warehouse handoff',ARRAY['Handoff'])
      RETURNING id,revision`;
    handoffs.push(conversation);
  }
  const winners=new Set();
  for(const [wave,filter] of ['tag=replacement','claim=unclaimed&tag=handoff','claim=mine&tag=handoff','q=Meridian','claim='+rep.viewer_id+'&mailbox=returns@example.test','messageText=serial%20zx418','status=needs_reply&waiting=24h&mailbox=returns@example.test'].entries()){
    if(wave)await delay(5000); // Same refresh interval as an open inbox.
    const start=performance.now();
    const times=await Promise.all(sessions.map(async person=>{
      const {headers,team,grant}=person,begin=performance.now();
      const page=await ok(read('/api/team-inbox?'+filter+(grant?'&workspaceId='+spaces[team]:''),headers));
      const elapsed=performance.now()-begin;
      if(wave===0){
        assert.equal(page.items.length,team===0?14:1);
        assert.ok(page.items.every(row=>row.mailbox===(team===0?'returns@example.test':'support-2@example.test')));
      }else if(wave===4||wave===6){
        assert.equal(page.items.length,team===0?14:0);
        assert.ok(page.items.every(row=>row.claimedBy===rep.viewer_id&&row.mailbox==='returns@example.test'));
      }else if(wave===3||wave===5){
        assert.deepEqual(page.items.map(row=>row.subject),team===0?['Capacity case 42123']:[]);
      }else{
        const expected=wave===1||winners.has(person)?[handoffs[team].id]:[];
        assert.deepEqual(page.items.map(row=>row.id),expected);
      }
      return elapsed;
    }));
    console.log('100 inbox readers, '+filter+', p95 ms:',Math.round(times.sort((a,b)=>a-b)[94]),
      'total ms:',Math.round(performance.now()-start));
    if(wave===1){
      // Two teammates saw each handoff unclaimed at the same revision.
      for(const [team,conversation] of handoffs.entries()){
        const pair=members.filter(person=>person.team===team).slice(0,2);
        const claims=await Promise.all(pair.map(({headers,grant})=>post('/api/team-inbox?workspaceId='+spaces[team]+'&grantId='+grant,
          {action:'claim',...conversation},headers)));
        assert.deepEqual(claims.map(r=>r.status).sort(),[200,409]);
        winners.add(pair[claims.findIndex(r=>r.ok)]);
      }
    }
  }
  for(const {headers,team} of members.slice(0,2)){
    assert.equal((await read('/api/team-inbox?tag=replacement&workspaceId='+spaces[1-team],headers)).status,404);
  }
}
