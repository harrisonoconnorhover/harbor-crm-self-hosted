import {prepareResponseTickets,verifyResponseFromInbox} from './portable-inbox-ticket-response-fixture.mjs';
import {verifyInboxExchangeUpgrade} from './portable-inbox-exchange-upgrade-fixture.mjs';
import {verifyInboxClaimUpgrade} from './portable-inbox-claim-upgrade-fixture.mjs';
import {verifyInboxHandoff} from './portable-inbox-handoff-fixture.mjs';
import {verifyInboxScale} from './portable-inbox-scale-fixture.mjs';
import {verifyInboxQueues} from './portable-inbox-queue-fixture.mjs';
import {verifyInboxArticle} from './portable-inbox-article-fixture.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appendFile,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const mailbox='support@example.test',inbound='trial@inbound.postmarkapp.com';
const token='fictional-postmark-server-token';
const uncertainBody='A fictional reply accepted before the connection dropped.';
const rejectedBody='A fictional reply rejected before delivery.';

// Installed only in the disposable web process. Store the provider's received envelope
// before simulating a lost response so duplicate delivery is independently observable.
export async function postmarkFetch(url,options){
  assert.equal(url.href,'https://api.postmarkapp.com/email');
  assert.equal(options.method,'POST');
  assert.equal(new Headers(options.headers).get('x-postmark-server-token'),token);
  const payload=JSON.parse(options.body),providerId=randomUUID();
  await appendFile(process.env.HARBOR_TEST_POSTMARK_RECEIPTS,JSON.stringify({providerId,payload})+'\n');
  if(payload.TextBody===uncertainBody)throw new TypeError('Fictional response lost after acceptance.');
  if(payload.TextBody===rejectedBody)return Response.json({ErrorCode:406,Message:'Inactive recipient'},{status:422});
  return Response.json({ErrorCode:0,Message:'OK',MessageID:providerId,SubmittedAt:new Date().toISOString(),To:payload.To});
}

function inboundEmail({sender='avery@example.test',recipient=inbound,subject='Dock scanner setup',body='How do we pair the scanner?',replyTo}={}){
  const messageId=randomUUID(),internetId='<'+messageId+'@sender.example.test>';
  const headers=[{Name:'Message-ID',Value:internetId}];
  if(replyTo)headers.push({Name:'In-Reply-To',Value:replyTo},{Name:'References',Value:replyTo});
  return {MessageID:messageId,OriginalRecipient:recipient,FromFull:{Email:sender,Name:'Avery Sample'},Subject:subject,
    TextBody:body,Headers:headers,Date:new Date().toUTCString()};
}

export async function verifyTeamInbox({request,origin,headers,other,signIn,sql,directory,configure}){
  const api='/api/team-inbox',intake=api+'/inbound',members='/api/workspaces';
  const post=(path,data,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(data)});
  async function ok(promise){
    const response=await promise;
    assert.ok(response.ok,await response.clone().text());return response.json();
  }
  const read=(path,auth=headers)=>request(path,{headers:auth});
  await ok(post('/api/crm',{action:'save',kind:'companies',data:{name:'Fictional Support Team'}}));
  const workspace=await ok(post(members,{action:'grant',email:'other@example.test'}));
  const workspaceId=workspace.owned,viewGrant=workspace.viewers.find(v=>v.email==='other@example.test');
  assert.ok(workspaceId&&viewGrant);
  const receipts=join(directory,'postmark-receipts.jsonl');
  await writeFile(receipts,'');
  const deliveries=async()=>(await readFile(receipts,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const salesInbound='trial-sales@inbound.postmarkapp.com';
  const secret=randomUUID(),auth={authorization:'Basic '+Buffer.from('harbor:'+secret).toString('base64')};
  await configure({HARBOR_TEAM_INBOX_ROUTES:JSON.stringify([{workspaceId,mailbox,inbound},{workspaceId,mailbox:'sales@example.test',inbound:salesInbound}]),HARBOR_TEAM_INBOX_SECRET:secret,
    HARBOR_TEAM_INBOX_POSTMARK_TOKEN:token,HARBOR_TEST_POSTMARK_RECEIPTS:receipts});
  const email=inboundEmail({body:'How do we pair the scanner? Reference cobalt turbine.'});
  assert.ok(!(await post(intake,email,{})).ok,'Inbound email requires the provider credential.');
  assert.ok(!(await post(intake,{...email,OriginalRecipient:'unknown@inbound.postmarkapp.com'},auth)).ok,'Wrong inbound address was accepted.');
  const list=()=>ok(read(api));
  assert.equal((await list()).items.length,0);
  const replay=await Promise.all([ok(post(intake,email,auth)),ok(post(intake,email,auth))]);
  assert.equal(replay[0].id,replay[1].id);
  assert.deepEqual(replay.map(r=>r.duplicate).sort(),[false,true]);
  const {id}=replay[0];
  const needsReply=async()=>(await ok(read(api+'?status=needs_reply'))).items.some(row=>row.id===id);
  assert.equal(await needsReply(),true);
  const detail=()=>ok(read(api+'?id='+id));
  const initial=await detail();
  assert.equal(initial.messages.length,1);
  assert.equal(initial.messages[0].body,email.TextBody);
  assert.equal((await list()).items.length,1);
  const otherRead=()=>read(api+'?'+new URLSearchParams({workspaceId,id}),other);
  assert.ok((await otherRead()).ok);
  const write=(action,revision,extra={})=>post(api,{action,id,revision,...extra});
  const asRep=(grant,action,revision,extra={})=>post(api+'?'+new URLSearchParams({workspaceId,grantId:grant.id}),{action,id,revision,...extra},other);
  const people=await sql`SELECT id,email,coalesce(nullif(full_name,''),email) AS label FROM login_identities
    WHERE email IN ('owner@example.test','other@example.test')`;
  const owner=people.find(row=>row.email==='owner@example.test'),rep=people.find(row=>row.email==='other@example.test');
  assert.equal((await write('assign',initial.conversation.revision,{assigneeId:rep.id})).status,409);
  const teamNote={noteId:randomUUID(),body:'Workspace-only note'};
  assert.equal((await asRep(viewGrant,'note',initial.conversation.revision,teamNote)).status,403);
  assert.equal((await asRep(viewGrant,'claim',initial.conversation.revision)).status,403);
  assert.ok(!(await read(api+'?id='+id,other)).ok);
  const promoted=await ok(post(members,{action:'role',id:viewGrant.id,role:'editor'}));
  let grant=promoted.viewers.find(v=>v.email==='other@example.test');
  const scope=async(viewScope,editScope)=>(await ok(post(members,{action:'record_scope',id:grant.id,viewScope,editScope}))).viewers[0];
  const sharedSnippets='/?view=snippets&workspaceId='+workspaceId;
  grant=await scope('owned','owned');
  assert.equal((await read(sharedSnippets,other)).status,404);
  assert.equal((await read(api+'?status=response_due&workspaceId='+workspaceId,other)).status,404);
  assert.equal((await read(api+'?messageText=cobalt&workspaceId='+workspaceId,other)).status,404);
  assert.equal((await otherRead()).status,404);
  assert.equal((await read(api+'?snippets=1&workspaceId='+workspaceId,other)).status,404);
  grant=await scope('all','owned');
  assert.ok((await otherRead()).ok);
  assert.equal((await asRep(grant,'claim',initial.conversation.revision)).status,403);
  assert.equal((await asRep(grant,'note',initial.conversation.revision,teamNote)).status,403);
  assert.equal((await write('assign',initial.conversation.revision,{assigneeId:rep.id})).status,409);
  grant=await scope('all','all');
  await ok(asRep(grant,'claim',initial.conversation.revision));
  const held=await detail();
  // A grant ID also rotates for unrelated permissions. Those changes must preserve the claim.
  grant=(await ok(post(members,{action:'contact_files',id:grant.id,enabled:true}))).viewers[0];
  assert.equal((await detail()).conversation.revision,held.conversation.revision);
  grant=await scope('all','owned');
  await verifyInboxClaimUpgrade({sql,workspaceId,ownerId:owner.id,repId:rep.id});
  const released=await detail();
  assert.equal(released.conversation.claimedBy,null,'A teammate who loses inbox edit access still holds this conversation.');
  assert.equal(released.conversation.revision,held.conversation.revision+1);
  assert.equal((await write('claim',held.conversation.revision)).status,409);
  grant=await scope('all','all');
  assert.equal((await detail()).conversation.claimedBy,null);
  const snippets=api+'?snippets=1';
  const teamSnippets=()=>read(snippets+'&workspaceId='+workspaceId,other);
  const snippet={id:randomUUID(),name:'Pairing a scanner',body:'Check the scanner label for your pairing code.'};
  const createSnippet={...snippet,action:'save_snippet',revision:0};
  await ok(post(api,createSnippet));
  const [firstSnippet]=(await ok(read(snippets))).items;
  const snippetLibrary=await read(sharedSnippets,other);
  assert.equal(snippetLibrary.status,200);
  assert.match(await snippetLibrary.text(),/<dt>Pairing a scanner<\/dt>/);
  assert.match(await (await read('/?view=snippets')).text(),/<h1>Snippets<\/h1>/);
  assert.equal(firstSnippet.id,snippet.id);
  assert.deepEqual((await ok(read(snippets,other))).items,[]);
  assert.deepEqual((await ok(teamSnippets())).items,[firstSnippet]);
  const changeSnippet={...createSnippet,revision:firstSnippet.revision,body:'The pairing instructions are attached to the scanner label.'};
  const sharedWrite=api+'?'+new URLSearchParams({workspaceId,grantId:grant.id});
  assert.equal((await post(sharedWrite,changeSnippet,other)).status,403);
  await ok(post(api,changeSnippet));
  assert.equal((await post(api,{...changeSnippet,body:'An obsolete version.'})).status,409);
  const [cannedReply]=(await ok(teamSnippets())).items;
  assert.equal(cannedReply.id,snippet.id);
  assert.equal(cannedReply.body,changeSnippet.body);
  const searchReplies=api+'?snippets=names';
  const selectedReply=snippets+'&id='+snippet.id;
  await sql`INSERT INTO portable_inbox_snippets(workspace_id,id,name,body,revision,slot)
    SELECT ${workspaceId},gen_random_uuid(),'Answer '||n,repeat('x',16000),1,n FROM generate_series(2,40) n`;
  const names=(await ok(read(searchReplies+'&workspaceId='+workspaceId,other))).items;
  assert.equal(names.length,40);
  assert.ok(names.every(row=>Object.keys(row).sort().join(',')==='id,name'));
  const wholeBytes=Buffer.byteLength(JSON.stringify((await ok(teamSnippets())).items));
  const namesBytes=Buffer.byteLength(JSON.stringify(names));
  console.log('40 fictional workspace quick replies, full library / names only (JSON bytes):',wholeBytes,namesBytes);
  assert.ok(namesBytes*100<wholeBytes);
  const byBody=searchReplies+'&q=INSTRUCTIONS&workspaceId='+workspaceId;
  assert.deepEqual((await ok(read(byBody,other))).items,[{id:snippet.id,name:snippet.name}]);
  assert.deepEqual((await ok(read(searchReplies+'&q=%25&workspaceId='+workspaceId,other))).items,[]);
  assert.deepEqual((await ok(read(selectedReply,other))).items,[]);
  assert.deepEqual((await ok(read(selectedReply+'&workspaceId='+workspaceId,other))).items,[cannedReply]);
  await sql`DELETE FROM portable_inbox_snippets WHERE workspace_id=${workspaceId} AND slot>1`;
  const [handoff,narrowed]=await Promise.all([
    write('assign',released.conversation.revision,{assigneeId:rep.id}),scope('all','owned')
  ]);
  assert.ok([200,409].includes(handoff.status),await handoff.clone().text());
  grant=narrowed;
  const afterRace=(await detail()).conversation;
  assert.equal(afterRace.claimedBy,null);
  grant=await scope('all','all');
  const attempts=await Promise.all([write('claim',afterRace.revision),asRep(grant,'claim',afterRace.revision)]);
  assert.deepEqual(attempts.map(result=>result.status).sort(),[200,409]);
  const repWon=attempts[1].ok;
  const claimedBy=repWon?(...args)=>asRep(grant,...args):write;
  const rival=repWon?write:(...args)=>asRep(grant,...args);
  let current=await detail();
  const conflictingReply={replyId:randomUUID(),body:'A second agent should never send this.'};
  assert.ok(!(await rival('reply',current.conversation.revision,conflictingReply)).ok);
  assert.deepEqual(await deliveries(),[]);
  await ok(claimedBy('tag',current.conversation.revision,{tags:['hardware','setup']}));
  current=await detail();
  assert.deepEqual([...current.conversation.tags].sort(),['hardware','setup']);
  const responseTickets=await prepareResponseTickets({post,ok,read,other});
  const reply={replyId:randomUUID(),body:cannedReply.body};
  const expectedRevision=current.conversation.revision;
  assert.equal((await ok(claimedBy('reply',expectedRevision,reply))).state,'sent');
  assert.equal((await ok(claimedBy('reply',expectedRevision,reply))).state,'sent');
  assert.equal(await needsReply(),false,'A confirmed reply clears an open conversation from Needs reply.');
  await verifyResponseFromInbox({origin,other,workspaceId,id,reply,incomingId:initial.messages[0].id,
    tickets:responseTickets,post,read,ok,detail,deliveries,signIn});
  const [sent]=await deliveries();
  assert.equal((await deliveries()).length,1);
  assert.equal(sent.payload.Metadata.harbor_reply_id,reply.replyId);
  assert.equal(sent.payload.From,mailbox);assert.equal(sent.payload.To,email.FromFull.Email);assert.equal(sent.payload.TextBody,reply.body);
  const header=name=>sent.payload.Headers.find(h=>h.Name.toLowerCase()===name)?.Value;
  assert.equal(header('in-reply-to'),email.Headers[0].Value);
  const messageId=header('message-id');assert.ok(messageId);
  current=await detail();
  assert.equal(current.messages.find(m=>m.id===reply.replyId).author,(repWon?rep:owner).label);
  assert.equal(current.messages.find(m=>m.direction==='incoming').author,null);
  const resolution=await ok(claimedBy('resolve',current.conversation.revision));
  assert.equal((await write('note',resolution.revision,teamNote)).status,409);
  assert.ok((await ok(read(api+'?status=resolved'))).items.some(row=>row.id===id));
  const followUp=inboundEmail({body:'That solved the issue.',replyTo:messageId});
  assert.equal((await ok(post(intake,followUp,auth))).id,id);
  current=await detail();
  assert.ok(current.messages.some(m=>m.body===followUp.TextBody));
  assert.equal(await needsReply(),true);
  assert.ok((await ok(read(api+'?status=open'))).items.some(row=>row.id===id));
  const stranger=inboundEmail({sender:'another@example.test',body:'Different customer',replyTo:messageId});
  assert.notEqual((await ok(post(intake,stranger,auth))).id,id);
  assert.ok(!(await detail()).messages.some(m=>m.body===stranger.TextBody));
  const salesEmail=inboundEmail({recipient:salesInbound,replyTo:messageId,body:'Different mailbox'});
  assert.notEqual((await ok(post(intake,salesEmail,auth))).id,id);
  assert.ok(!(await detail()).messages.some(m=>m.body===salesEmail.TextBody));
  await ok(write('claim',current.conversation.revision));
  current=await detail();
  const uncertain={replyId:randomUUID(),body:uncertainBody};
  const otherCase=(await ok(post('/api/tickets',{action:'save',data:{name:'Scanner replacement',ticketPriority:'High'}}))).record;
  const beforeSending=current.conversation.revision;
  const lost=await ok(write('reply',beforeSending,uncertain));
  assert.equal(lost.state,'uncertain');
  assert.equal(await needsReply(),true,'An unconfirmed delivery is still waiting for a reply.');
  const logOther=replyId=>post('/api/tickets',responseTickets.payload(responseTickets.second,replyId));
  assert.equal((await logOther(uncertain.replyId)).status,409);
  await configure({}); // Restart the web process while only the provider knows the outcome.
  const retried=await ok(write('reply',beforeSending,uncertain));
  assert.equal(retried.state,'uncertain');
  current=await detail();
  assert.ok(current.messages.some(m=>m.body===uncertainBody&&m.state==='uncertain'));
  assert.equal((await write('reply',current.conversation.revision,{...uncertain,replyId:randomUUID()})).status,409);
  assert.equal((await deliveries()).length,2,'A lost receipt must not lead to another send');
  const queue=()=>ok(read(api+'?status=review'));
  assert.deepEqual((await queue()).items.map(thread=>thread.id),[id]);
  assert.deepEqual((await ok(read(api+'?status=review&claim=mine&tag=hardware'))).items.map(thread=>thread.id),[id]);
  await ok(write('assign',current.conversation.revision,{assigneeId:rep.id}));
  current=await detail();
  assert.equal(current.pendingReply.id,uncertain.replyId);
  assert.equal((await asRep(grant,'reply',current.conversation.revision,{replyId:randomUUID(),body:'Another attempt'})).status,409);
  grant=await scope('all','owned');
  current=await detail();
  assert.equal(current.conversation.claimedBy,null);
  assert.equal(current.pendingReply.id,uncertain.replyId);
  assert.equal((await post('/api/tickets?'+new URLSearchParams({workspaceId,grantId:grant.id}),
    responseTickets.payload(responseTickets.first,reply.replyId),other)).status,404);
  assert.deepEqual((await ok(read(api+'?status=review&claim=unclaimed'))).items.map(row=>row.id),[id]);
  await ok(write('claim',current.conversation.revision));
  current=await detail();
  assert.equal((await write('reply',current.conversation.revision,{replyId:randomUUID(),body:'New claimant retry'})).status,409);
  grant=await scope('all','all');
  assert.equal((await deliveries()).length,2);
  for(let n=0;n<26;n++){
    const later=inboundEmail({replyTo:messageId,body:'Fictional follow-up '+n});
    assert.equal((await ok(post(intake,later,auth))).id,id);
  }
  current=await detail();
  assert.ok(current.next);
  const exact=api+'?'+new URLSearchParams({id,messageId:reply.replyId});
  assert.deepEqual((await ok(read(exact))).messages.map(m=>m.id),[reply.replyId]);
  assert.equal((await read(exact.replace(id,randomUUID()))).status,404);
  assert.ok(!current.messages.some(message=>message.id===uncertain.replyId));
  assert.equal(current.pendingReply.id,uncertain.replyId);
  assert.equal(current.pendingReply.state,'uncertain');
  assert.deepEqual((await queue()).items.map(thread=>thread.id),[id]);
  assert.equal((await write('resolve',current.conversation.revision)).status,409);
  assert.ok(!(await asRep(grant,'confirm_sent',current.conversation.revision,{replyId:uncertain.replyId})).ok);
  await ok(write('confirm_sent',current.conversation.revision,{replyId:uncertain.replyId}));
  assert.equal(await needsReply(),true,'Later customer mail still needs a reply after an older delivery is confirmed.');
  current=await detail();
  assert.equal(current.pendingReply,null);
  assert.deepEqual((await queue()).items,[]);
  const earlier=await ok(read(api+'?'+new URLSearchParams({id,after:current.next})));
  assert.ok(earlier.messages.some(m=>m.id===uncertain.replyId&&m.body===uncertainBody&&m.state==='sent'));
  assert.equal((await ok(write('reply',current.conversation.revision,{replyId:randomUUID(),body:rejectedBody}))).state,'failed');
  current=await detail();
  const failed=current.messages.find(message=>message.body===rejectedBody);
  assert.equal((await logOther(failed.id)).status,409);
  const competing=[responseTickets.second,otherCase];
  const reconciled=await Promise.all(competing.map(ticket=>post('/api/tickets',responseTickets.payload(ticket,uncertain.replyId))));
  assert.deepEqual(reconciled.map(r=>r.status).sort(),[200,409]);
  const winner=competing[reconciled.findIndex(r=>r.ok)];
  await ok(post('/api/tickets',responseTickets.payload(winner,uncertain.replyId)));
  assert.equal((await ok(read('/api/tickets?id='+winner.id))).firstResponse.inboxConversationId,id);
  const beforeHandoff=await detail();
  await sql`ALTER TABLE portable_inbox_conversations ADD CONSTRAINT fixture_block_assignment CHECK (claimed_by IS NULL) NOT VALID`;
  try{
    const failedAssignment=await write('assign',beforeHandoff.conversation.revision,{assigneeId:rep.id,note:'Fictional failed transfer'});
    assert.equal(failedAssignment.status,503);
    const reloaded=await detail();
    assert.deepEqual(reloaded.conversation,beforeHandoff.conversation);
    assert.deepEqual(reloaded.messages,beforeHandoff.messages);
  }finally{await sql`ALTER TABLE portable_inbox_conversations DROP CONSTRAINT fixture_block_assignment`;}
  // Begin the three-agent handoff with a fresh request window after the failure rehearsals.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  const emailSpecialist='invitee@example.test';
  const specialistSession=await signIn(emailSpecialist);
  const updateSpecialist=async body=>(await ok(post(members,body))).viewers.find(member=>member.email===emailSpecialist);
  let specialistGrant=await updateSpecialist({action:'grant',email:emailSpecialist});
  const responseTicketPath='/api/tickets?id='+responseTickets.first.id+'&workspaceId='+workspaceId;
  const visibleResponse=(await ok(read(responseTicketPath,specialistSession))).firstResponse;
  assert.equal(visibleResponse.summary,'Reply from '+mailbox);
  assert.equal(visibleResponse.inboxReplyId,reply.replyId);
  const inboxAccess=async view=>updateSpecialist({action:'tool_permissions',ids:[specialistGrant.id],tool:'team-inbox',
    policy:{view,edit:'none',create:false,delete:false}});
  specialistGrant=await inboxAccess('none');
  const restricted=(await ok(read(responseTicketPath,specialistSession))).firstResponse;
  assert.deepEqual(restricted,{...visibleResponse,summary:'Reply from team inbox',inboxConversationId:null,inboxReplyId:null});
  const matches=await ok(read('/api/tickets?workspaceId='+workspaceId+'&search=Dock%20scanner%20case',specialistSession));
  assert.deepEqual(matches.records.find(ticket=>ticket.id===responseTickets.first.id)?.firstResponse,restricted);
  specialistGrant=await inboxAccess('all');
  assert.deepEqual((await ok(read(responseTicketPath,specialistSession))).firstResponse,visibleResponse);
  specialistGrant=await updateSpecialist({action:'role',id:specialistGrant.id,role:'editor'});
  specialistGrant=await updateSpecialist({action:'record_scope',id:specialistGrant.id,viewScope:'owned',editScope:'owned'});
  const [specialist]=await sql`SELECT id FROM login_identities WHERE email=${emailSpecialist}`;
  const {handoffId,noteId}=await verifyInboxHandoff({sql,id,workspaceId,headers,other,owner,rep,origin,detail,deliveries,specialistId:specialist.id,
    write,asRep:(action,revision,extra)=>asRep(grant,action,revision,extra),reply,replyAuthor:repWon?rep:owner});
  const historyUrl=api+'?'+new URLSearchParams({id,workspaceId,history:'team'});
  assert.equal((await read(historyUrl,specialistSession)).status,404);
  assert.equal((await read(api+'?history=team')).status,400);
  assert.equal((await read(historyUrl+'&messageId='+initial.messages[0].id,other)).status,400);
  await verifyTeamHistoryPages({workspaceId,id,actorId:owner.id,sql,history:after=>ok(read(historyUrl+(after?'&after='+after:''),other)),noteId,handoffId});
  const delegated=await detail();
  const ticketPath='/api/tickets?id='+delegated.ticket.id+'&workspaceId='+workspaceId;
  const specialistTicket=await ok(read(ticketPath,specialistSession));
  assert.equal(specialistTicket.assigneeId,specialist.id);
  assert.equal(specialistTicket.inboxConversationId,null);
  assert.equal((await read(api+'?id='+id+'&workspaceId='+workspaceId,specialistSession)).status,404);
  const [assignmentEvent]=await sql`SELECT actor_id FROM portable_ticket_events
    WHERE workspace_id=${workspaceId} AND ticket_id=${delegated.ticket.id} AND revision=${delegated.ticket.revision}`;
  assert.equal(assignmentEvent.actor_id,rep.id);
  await ok(write('assign_ticket',delegated.conversation.revision,{ticketId:delegated.ticket.id,ticketRevision:delegated.ticket.revision,assigneeId:owner.id}));
  assert.equal((await read(ticketPath,specialistSession)).status,404);
  await ok(post(members,{action:'revoke',id:specialistGrant.id}));
  assert.equal((await read(ticketPath,specialistSession)).status,404);
  const unanswered=competing.find(ticket=>ticket.id!==winner.id);
  const noteResponse=await post('/api/tickets',responseTickets.payload(unanswered,noteId));
  assert.equal(noteResponse.status,409);
  assert.match((await noteResponse.json()).error,/Choose a confirmed reply/);
  const privateResponse=await post('/api/tickets',responseTickets.payload(unanswered,handoffId));
  assert.equal(privateResponse.status,409);
  assert.match((await privateResponse.json()).error,/Choose a confirmed reply/);
  // A delivery that needs investigation must leave the linked ticket's SLA clock running.
  const escalated=(await detail()).ticket.id;
  const response=async ticket=>(await ok(read('/api/tickets?id='+ticket))).firstResponse;
  const waiting=await response(escalated);
  assert.equal(waiting.targetMinutes,60);
  assert.equal(waiting.respondedAt,null);
  const uncertainLinked={replyId:randomUUID(),body:uncertainBody};
  const revision=(await detail()).conversation.revision;
  assert.equal((await ok(asRep(grant,'reply',revision,uncertainLinked))).state,'uncertain');
  const pendingCase=await detail();
  const blockedClose=await asRep(grant,'resolve',pendingCase.conversation.revision,{linkedTicket:{id:escalated,revision:pendingCase.ticket.revision}});
  assert.equal(blockedClose.status,409);
  assert.match((await blockedClose.json()).error,/pending reply/);
  assert.deepEqual(await response(escalated),waiting);
  const duePage=api+'?status=response_due&claim=mine&mailbox='+encodeURIComponent(mailbox)+'&workspaceId='+workspaceId;
  const due=await ok(read(duePage,other));
  assert.deepEqual(due.items.map(row=>row.id),[id]);
  assert.equal(due.items[0].firstResponse.ticketId,escalated);
  assert.equal(Date.parse(due.items[0].firstResponse.responseDueAt),Date.parse(waiting.dueAt));
  assert.deepEqual((await ok(read(api+'?status=response_due',other))).items,[]);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const mobile=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=other.cookie.split('=');
    await mobile.context().addCookies([{name,value,url:origin}]);
    await mobile.goto(origin+'/?view=team-inbox&claim=mine&workspaceId='+workspaceId);
    await mobile.getByRole('link',{name:'First responses due',exact:true}).click();
    const deadline=mobile.getByRole('link',{name:/First response due ·/});
    assert.equal(new URL(await deadline.getAttribute('href'),origin).searchParams.get('id'),escalated);
    await sql`UPDATE portable_ticket_first_responses SET due_at=now()+interval '20 minutes'
      WHERE workspace_id=${workspaceId} AND ticket_id=${escalated}`;
    await mobile.getByRole('searchbox',{name:'Message text',exact:true}).fill('TURBINE cobalt');
    await mobile.getByRole('combobox',{name:'Reply deadline',exact:true}).selectOption('due_next_hour');
    await mobile.getByRole('button',{name:'Apply filters'}).click();
    assert.equal(await mobile.getByRole('combobox',{name:'Claim',exact:true}).inputValue(),'mine');
    const queueUrl=mobile.url();
    await mobile.getByRole('link',{name:'Open matching message',exact:true}).click();
    assert.equal(new URL(mobile.url()).searchParams.get('messageId'),initial.messages[0].id);
    await mobile.getByText(email.TextBody,{exact:true}).waitFor();
    await mobile.getByRole('link',{name:'Inbox',exact:true}).click();
    assert.equal(await mobile.getByRole('searchbox',{name:'Message text',exact:true}).inputValue(),'TURBINE cobalt');
    assert.equal(new URL(queueUrl).searchParams.get('responseWindow'),'due_next_hour');
    await mobile.getByRole('link',{name:due.items[0].subject,exact:true}).click();
    await mobile.locator('.inbox-details .inbox-deadline').waitFor();
    await mobile.getByRole('link',{name:'Inbox',exact:true}).click();
    assert.deepEqual([...new URL(mobile.url()).searchParams].sort(),[...new URL(queueUrl).searchParams].filter(([,v])=>v).sort());
    assert.equal(await mobile.getByRole('combobox',{name:'Reply deadline',exact:true}).inputValue(),'due_next_hour');
    await mobile.getByRole('link',{name:'Open',exact:true}).click();
    assert.equal(new URL(mobile.url()).searchParams.has('responseWindow'),false);
    await mobile.getByRole('link',{name:due.items[0].subject,exact:true}).waitFor();
  }finally{await browser.close();}
  await ok(write('confirm_sent',(await detail()).conversation.revision,{replyId:uncertainLinked.replyId}));
  assert.deepEqual((await ok(read(duePage,other))).items,[]);
  assert.deepEqual((await ok(read(duePage+'&responseWindow=due_next_hour',other))).items,[]);
  assert.deepEqual((await ok(read(api+'?messageText=turbine',other))).items,[]);
  assert.deepEqual((await ok(read(api+'?messageText=turbine%20unmatched'))).items,[]);
  const recorded=await response(escalated);
  assert.equal(recorded.inboxReplyId,uncertainLinked.replyId);
  assert.equal(recorded.actorId,rep.id,'Credit the replying rep even when the owner confirms delivery');
  assert.equal(recorded.status,'met');
  assert.equal((await ok(asRep(grant,'reply',revision,uncertainLinked))).state,'sent');
  assert.deepEqual(await response(escalated),recorded);
  // Article lookup starts a separate agent session after the two-agent collaboration rehearsal.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  await verifyInboxArticle({origin,request,post,ok,other,workspaceId,id,deliveries,cannedReply});
  // The queue rehearsal simulates a separate work session after claim, handoff, and ticket writes.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  await verifyInboxQueues({origin,sql,workspaceId,id,other,headers,read,post,ok,ownerId:owner.id});
  await verifyInboxExchangeUpgrade(sql,workspaceId,owner.id);
  await verifyInboxScale({read,post,ok,sql,workspaceId,headers,other,configure});
  // Start the independent revocation rehearsal with fresh local request budgets after the load test.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  const beforeRemoval=await detail();
  assert.equal(beforeRemoval.conversation.claimedBy,rep.id);
  const linkedTicket=beforeRemoval.ticket.id;
  const ticketViews=async(actorId,ticketId)=>Number((await sql`SELECT count(*) FROM portable_record_access_events
    WHERE workspace_id=${workspaceId} AND actor_id=${actorId} AND action='related' AND kind='tickets'
      AND record_ids=ARRAY[${ticketId}::uuid]`)[0].count);
  const initialViews=await ticketViews(rep.id,linkedTicket);
  const sharedPage='/?view=team-inbox&id='+id+'&workspaceId='+workspaceId;
  assert.equal((await request(sharedPage,{method:'HEAD',headers:other})).status,200);
  assert.equal((await request(api+'?id='+id+'&workspaceId='+workspaceId,{method:'HEAD',headers:other})).status,200);
  assert.equal(await ticketViews(rep.id,linkedTicket),initialViews);
  assert.equal((await read(sharedPage,other)).status,200);
  await ok(otherRead());
  assert.equal(await ticketViews(rep.id,linkedTicket),initialViews+2);
  const [saved]=await sql`SELECT e.data,e.actor_id,e.revision FROM portable_tickets t JOIN portable_ticket_events e
    ON (e.workspace_id,e.ticket_id)=(t.workspace_id,t.id) WHERE t.workspace_id=${workspaceId} AND t.id=${linkedTicket} AND e.revision=1`;
  assert.equal(saved.actor_id,rep.id);
  assert.equal(saved.revision,1);
  assert.equal(saved.data.data.ticketSource,'Email');
  assert.ok(!saved.data.data.description);
  assert.equal((await read('/tickets?id='+linkedTicket,other)).status,404);
  await sql`UPDATE portable_tickets SET archived_at=now() WHERE workspace_id=${workspaceId} AND id=${linkedTicket}`;
  const archived=await detail();
  assert.ok(archived.ticket.archivedAt);
  const archivedPage=await (await read('/?view=team-inbox&id='+id)).text();
  assert.match(archivedPage,/Linked ticket is in the recycle bin/);
  assert.equal((await ok(asRep(grant,'create_ticket',archived.conversation.revision))).ticketId,linkedTicket);
  await sql`UPDATE portable_tickets SET archived_at=NULL WHERE workspace_id=${workspaceId} AND id=${linkedTicket}`;
  assert.deepEqual((await detail()).ticket,{id:linkedTicket,status:'New',tags:['hardware','setup'],revision:delegated.ticket.revision+1,assigneeId:owner.id,assigneeLabel:owner.label,archivedAt:null,firstResponse:null});
  const existingInput={action:'save',data:{name:'Previously opened scanner ticket',ticketPriority:'High'}};
  const {record:existing}=await ok(post('/api/tickets',existingInput));
  const {record:foreignTicket}=await ok(post('/api/tickets',existingInput,other));
  const secondEmail=inboundEmail({subject:'Second scanner inquiry'});
  const {id:secondThread}=await ok(post(intake,secondEmail,auth));
  const link=(identity,path,revision,target={})=>post(path,{action:'link_ticket',id:secondThread,revision,ticketId:existing.id,
    ticketRevision:existing.revision,...target},identity);
  const sharedApi=api+'?'+new URLSearchParams({workspaceId,grantId:grant.id});
  const heldThread=await ok(post(sharedApi,{action:'claim',id:secondThread,revision:1},other));
  assert.equal((await link(headers,api,heldThread.revision)).status,409,'Only the claimant can link an existing ticket.');
  assert.equal((await link(other,sharedApi,1)).status,409);
  assert.equal((await link(other,sharedApi,heldThread.revision,{ticketRevision:existing.revision+1})).status,409);
  assert.equal((await link(other,sharedApi,heldThread.revision,{ticketId:foreignTicket.id})).status,404);
  const occupied=await ok(read('/api/tickets?id='+linkedTicket));
  assert.equal((await link(other,sharedApi,heldThread.revision,{ticketId:occupied.id,ticketRevision:occupied.revision})).status,409);
  await linkTicketFromInbox({origin,workspaceId,identity:other,conversationId:secondThread,ticket:existing});
  assert.deepEqual(await ok(link(other,sharedApi,heldThread.revision)),{id:secondThread,revision:heldThread.revision+1,ticketId:existing.id});
  assert.equal((await link(other,sharedApi,heldThread.revision,{ticketId:linkedTicket})).status,409);
  const scannerFollowUp=inboundEmail({subject:'Re: Second scanner inquiry',replyTo:secondEmail.Headers[0].Value,body:'The scanner stopped again.'});
  await verifyCaseResolution({origin,workspaceId,identity:other,id:secondThread,ticket:existing,repId:rep.id,sql,ok,
    conversation:()=>ok(read(api+'?id='+secondThread)),record:()=>ok(read('/api/tickets?id='+existing.id)),
    change:(body,asOwner=false)=>post(asOwner?api:sharedApi,{id:secondThread,...body},asOwner?headers:other),
    receive:()=>ok(post(intake,scannerFollowUp,auth))});
  await verifyTicketTagTriage({origin,workspaceId,identity:other,id:secondThread,ticketId:existing.id,sql,ok,
    detail:()=>ok(read(api+'?id='+secondThread)),read,post,sharedApi,repId:rep.id});

  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  await ok(post(members,{action:'revoke',id:grant.id}));
  assert.equal((await link(other,sharedApi,heldThread.revision)).status,403);
  assert.equal((await read(api+'?workspaceId='+workspaceId+'&ticketTag=warranty',other)).status,404);

  assert.equal((await read('/tickets?id='+linkedTicket+'&workspaceId='+workspaceId,other)).status,404);
  assert.equal((await read(historyUrl,other)).status,404);
  for(const messageId of [noteId,handoffId])assert.equal((await read(api+'?'+new URLSearchParams({workspaceId,id,messageId}),other)).status,404);
  assert.equal((await read(api+'?q=meridian&workspaceId='+workspaceId,other)).status,404);
  assert.equal((await read('/?view=knowledge&workspaceId='+workspaceId,other)).status,404);
  for(const mode of ['1','topics'])assert.equal((await read(api+'?articles='+mode+'&workspaceId='+workspaceId,other)).status,404);
  assert.ok(!(await otherRead()).ok);
  assert.ok(!(await read(exact+'&workspaceId='+workspaceId,other)).ok);
  assert.ok(!(await teamSnippets()).ok);
  assert.equal((await read(byBody,other)).status,404);
  assert.equal((await read(selectedReply+'&workspaceId='+workspaceId,other)).status,404);
  current=await detail();
  assert.ok(!(await asRep(grant,'reply',current.conversation.revision,{replyId:randomUUID(),body:'An expired grant'})).ok);
  assert.equal(current.conversation.claimedBy,null);
  assert.equal(current.conversation.revision,beforeRemoval.conversation.revision+1);
  assert.deepEqual(current.messages,beforeRemoval.messages);
  await ok(write('claim',current.conversation.revision));
  assert.equal((await deliveries()).length,5);
  await ok(post(api,{action:'delete_snippet',id:cannedReply.id,revision:cannedReply.revision}));
  assert.deepEqual((await ok(read(snippets))).items,[]);
  assert.equal((await deliveries())[0].payload.TextBody,cannedReply.body);
  const action=(action,revision,extra={})=>post(api,{action,id:secondThread,revision,...extra});
  const nextRevision=async()=>(await ok(read(api+'?id='+secondThread))).conversation.revision;
  const claimed=await ok(action('claim',await nextRevision()));
  const linked={ticketId:existing.id,revision:claimed.revision};
  const rejection=await ok(action('reply',linked.revision,{replyId:randomUUID(),body:rejectedBody}));
  assert.equal(rejection.state,'failed');
  assert.equal((await response(linked.ticketId)).respondedAt,null);
  const firstReply={replyId:randomUUID(),body:'Try reconnecting your scanner.'};
  const before=await deliveries();
  assert.equal((await ok(action('reply',await nextRevision(),firstReply))).state,'sent');
  const first=await response(linked.ticketId);
  assert.equal(first.inboxReplyId,firstReply.replyId);
  assert.equal(first.inboxConversationId,secondThread);
  assert.equal(first.actorId,owner.id);
  const priorViews=await ticketViews(owner.id,linked.ticketId);
  const source=(await ok(read(api+'?id='+secondThread))).messages.find(m=>m.id===firstReply.replyId);
  assert.equal(source.responseTicketId,linked.ticketId);
  assert.equal(await ticketViews(owner.id,linked.ticketId),priorViews+1,'A linked ticket and its response produce one preview.');
  assert.equal(first.respondedAt,new Date(source.createdAt).toISOString());
  await ok(action('reply',await nextRevision(),{replyId:randomUUID(),body:'Let us know how it goes.'}));
  assert.deepEqual(await response(linked.ticketId),first);
  assert.equal((await deliveries()).length,before.length+2);

  const {id:raceId}=await ok(post(intake,inboundEmail({subject:'Competing telephone and email responses'}),auth));
  const raceAction=(action,revision,extra={})=>post(api,{action,revision,id:raceId,...extra});
  const raceClaim=await ok(raceAction('claim',1));
  const raceTicket=await ok(raceAction('create_ticket',raceClaim.revision,{priority:'High'}));
  const delayed={replyId:randomUUID(),body:uncertainBody};
  await ok(raceAction('reply',raceTicket.revision,delayed));
  const phone={action:'first_response',id:raceTicket.ticketId,expectedRevision:1,channel:'Phone',summary:'Answered by phone.'};
  const [confirmation,manual]=await Promise.all([
    raceAction('confirm_sent',(await ok(read(api+'?id='+raceId))).conversation.revision,{replyId:delayed.replyId}),post('/api/tickets',phone),
  ]);
  assert.equal(confirmation.status,200);
  assert.ok([200,409].includes(manual.status));
  const outcome=await response(raceTicket.ticketId);
  assert.equal(outcome.channel,manual.ok?'Phone':'Email');
  assert.equal(outcome.inboxReplyId,manual.ok?null:delayed.replyId);
  await verifyFirstResponsePages({sql,workspaceId,read,ok,request,headers});

}

async function verifyTeamHistoryPages({workspaceId,id,actorId,sql,history,noteId,handoffId}){
  const baseline=await history();
  assert.ok(baseline.messages.some(row=>row.id===noteId)&&baseline.messages.some(row=>row.id===handoffId));
  assert.equal(baseline.next,null);
  const ids=Array.from({length:27},()=>randomUUID()).sort().reverse();
  await sql`INSERT INTO portable_inbox_messages(workspace_id,id,conversation_id,mailbox,actor_id,direction,state,body,created_at)
    SELECT ${workspaceId},note_id,${id},${mailbox},${actorId},'internal','note','Earlier support shift',timestamptz '2010-01-01'
    FROM unnest(${ids}::uuid[]) AS note_id`;
  try{
    const first=await history();
    assert.equal(first.messages.length,25);
    assert.equal(first.next,first.messages.at(-1).id);
    const rest=await history(first.next);
    assert.equal(rest.next,null);
    const all=[...first.messages,...rest.messages];
    assert.ok(all.every(message=>message.direction==='internal'));
    assert.deepEqual(all.map(message=>message.id),[...baseline.messages.map(message=>message.id),...ids]);
  }finally{
    await sql`DELETE FROM portable_inbox_messages WHERE workspace_id=${workspaceId} AND conversation_id=${id} AND id=ANY(${ids}::uuid[])`;
  }
}

async function verifyFirstResponsePages({sql,workspaceId,read,ok,request,headers}){
  const tickets=Array.from({length:29},(_,i)=>({
    id:randomUUID(),thread:randomUUID(),name:'Deadline page '+i,
    due:i<27?'2026-01-02T09:00:00.123456Z':'2099-01-02T09:00:00.123456Z',
  }));
  await sql.begin(async tx=>{
    for(const [index,t] of tickets.entries()){
      await tx`INSERT INTO portable_inbox_conversations(workspace_id,id,mailbox,sender,subject,status)
        VALUES (${workspaceId},${t.thread},'shift@example.test','fiction@example.test',${t.name},${index===0?'resolved':'open'})`;
      await tx`INSERT INTO portable_tickets(workspace_id,id,data,revision,created_at,updated_at,archived_at)
        VALUES (${workspaceId},${t.id},${tx.json({name:t.name,ticketStatus:'New',tags:index%7===0?['contract']:[]})},1,now(),now(),${index===28?new Date():null})`;
      await tx`INSERT INTO portable_inbox_ticket_links(workspace_id,ticket_id,conversation_id)
        VALUES (${workspaceId},${t.id},${t.thread})`;
      await tx`INSERT INTO portable_ticket_first_responses(workspace_id,ticket_id,policy_revision,target_minutes,started_at,due_at)
        SELECT workspace_id,${t.id},revision,60,${t.due}::timestamptz-interval '1 hour',${t.due}::timestamptz
        FROM portable_ticket_response_policies WHERE workspace_id=${workspaceId} ORDER BY revision DESC LIMIT 1`;
    }
  });
  const path='/api/team-inbox?status=response_due&mailbox=shift%40example.test&claim=unclaimed';
  const expected=tickets.slice(0,-1).sort((a,b)=>a.due.localeCompare(b.due)||a.id.localeCompare(b.id));
  const accesses=()=>sql`SELECT record_ids FROM portable_record_access_events
    WHERE workspace_id=${workspaceId} AND record_ids && ${sql.array(tickets.map(t=>t.id))}::uuid[]`;
  assert.equal((await request(path,{method:'HEAD',headers})).status,200);
  assert.equal((await accesses()).length,0);
  const first=await ok(read(path));
  assert.deepEqual(first.items.map(row=>row.firstResponse.ticketId),expected.slice(0,25).map(t=>t.id));
  assert.ok(first.items.every(row=>row.firstResponse.overdue));
  assert.deepEqual((await accesses())[0].record_ids,first.items.map(row=>row.firstResponse.ticketId));
  const tagged=await ok(read(path+'&ticketTag=contract'));
  assert.deepEqual(tagged.items.map(row=>row.id),expected.filter(t=>tickets.indexOf(t)%7===0).map(t=>t.thread));
  const boundary=first.items.at(-1);
  await sql`UPDATE portable_tickets SET archived_at=now() WHERE workspace_id=${workspaceId} AND id=${boundary.firstResponse.ticketId}`;
  const rest=await ok(read(path+'&after='+encodeURIComponent(first.next)));
  assert.deepEqual(rest.items.map(row=>row.id),expected.slice(25).map(t=>t.thread));
  assert.equal(rest.items.at(-1).firstResponse.overdue,false);
  assert.equal(rest.next,null);
  assert.ok([...first.items,...rest.items].some(row=>row.status==='resolved'));
  // Give two active conversations deadlines on opposite sides of the coming hour.
  const soon=tickets[27],later=tickets.find(t=>t.id!==boundary.firstResponse.ticketId&&t!==soon);
  await sql`UPDATE portable_ticket_first_responses SET started_at=now()-interval '30 minutes',due_at=now()+interval '30 minutes'
    WHERE workspace_id=${workspaceId} AND ticket_id=${soon.id}`;
  await sql`UPDATE portable_ticket_first_responses SET due_at=now()+interval '61 minutes'
    WHERE workspace_id=${workspaceId} AND ticket_id=${later.id}`;
  const upcoming=await ok(read(path+'&responseWindow=due_next_hour'));
  assert.deepEqual(upcoming.items.map(row=>row.id),[soon.thread]);
  assert.equal(upcoming.items[0].firstResponse.overdue,false);
  const missed=await ok(read(path+'&responseWindow=overdue'));
  const past=expected.filter(t=>t.id!==boundary.firstResponse.ticketId&&t!==soon&&t!==later);
  assert.deepEqual(missed.items.map(row=>row.id),past.map(t=>t.thread));
  assert.equal((await read('/api/team-inbox?status=open&responseWindow=overdue')).status,400);
}

async function linkTicketFromInbox({origin,workspaceId,identity,conversationId,ticket}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.setDefaultTimeout(10000);
    const [name,value]=identity.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?'+new URLSearchParams({view:'team-inbox',id:conversationId,workspaceId}));
    await page.getByRole('button',{name:'Link existing ticket'}).click();
    await page.getByLabel('Find a ticket').fill(ticket.data.name);
    await page.getByRole('combobox',{name:/^Existing ticket/}).selectOption(ticket.id);
    await page.getByRole('button',{name:'Link ticket',exact:true}).click();
    await page.getByRole('link',{name:'Open linked ticket'}).click();
    assert.equal(new URL(page.url()).searchParams.get('id'),ticket.id);
    assert.equal(new URL(page.url()).searchParams.get('workspaceId'),workspaceId);
    await page.getByRole('link',{name:'Open original conversation'}).click();
    assert.equal(new URL(page.url()).searchParams.get('id'),conversationId);
    assert.equal(new URL(page.url()).searchParams.get('workspaceId'),workspaceId);
  }finally{await browser.close();}
}

async function verifyCaseResolution({origin,workspaceId,identity,id,ticket,repId,sql,ok,conversation,record,change,receive}){
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  const initial=await conversation();
  const close={action:'resolve',revision:initial.conversation.revision,linkedTicket:{id:ticket.id,revision:ticket.revision}};
  assert.equal((await change(close,true)).status,409,'The owner cannot close the case out from under its claimant.');
  assert.equal((await change({...close,revision:close.revision-1})).status,409);
  assert.equal((await change({...close,linkedTicket:{id:randomUUID(),revision:ticket.revision}})).status,409);
  assert.equal((await change({...close,linkedTicket:{id:ticket.id,revision:ticket.revision+1}})).status,409);
  await sql`ALTER TABLE portable_inbox_conversations ADD CONSTRAINT fixture_block_resolution CHECK (status <> 'resolved') NOT VALID`;
  try{
    assert.equal((await change(close)).status,503);
    assert.deepEqual((await conversation()).conversation,initial.conversation);
    assert.equal((await record()).revision,ticket.revision,'Failed resolution must roll back the ticket write.');
  }finally{await sql`ALTER TABLE portable_inbox_conversations DROP CONSTRAINT fixture_block_resolution`;}
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.setDefaultTimeout(10000);
    const [name,value]=identity.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?'+new URLSearchParams({view:'team-inbox',id,workspaceId}));
    await page.getByText('Ticket status · New',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Resolve conversation and close ticket'}).click();
    await page.getByText('Ticket status · Closed',{exact:true}).waitFor();
    const closed=await record(),resolved=await conversation();
    assert.ok(closed.closedAt);
    assert.equal(closed.revision,ticket.revision+1);
    assert.equal(resolved.conversation.status,'resolved');
    assert.equal(resolved.conversation.claimedBy,null);
    assert.equal((await receive()).id,id);
    assert.equal((await receive()).duplicate,true);
    assert.equal((await record()).closedAt,closed.closedAt);
    assert.equal((await conversation()).conversation.status,'open');
    await page.reload();
    await page.getByRole('button',{name:'Claim conversation'}).click();
    const reopen=page.getByRole('button',{name:'Reopen ticket',exact:true});
    await reopen.waitFor();
    const reviewed=await conversation();
    const request={action:'reopen_ticket',revision:reviewed.conversation.revision,linkedTicket:{id:ticket.id,revision:closed.revision}};
    await reopen.click();
    await page.getByText('Ticket status · Waiting on us',{exact:true}).waitFor();
    assert.equal((await change(request)).status,409,'Retry must not duplicate the status change.');
    const reopened=await record();
    assert.equal(reopened.closedAt,null);
    assert.equal(reopened.assigneeId,closed.assigneeId);
    assert.equal(reopened.revision,closed.revision+1);
    const events=await sql`SELECT actor_id, data->'data'->>'ticketStatus' AS status FROM portable_ticket_events
      WHERE workspace_id=${workspaceId} AND ticket_id=${ticket.id} AND revision>${ticket.revision} ORDER BY revision`;
    assert.deepEqual([...events],[{actor_id:repId,status:'Closed'},{actor_id:repId,status:'Waiting on us'}]);
    await ok(change({action:'resolve',revision:reviewed.conversation.revision}));
    assert.equal((await record()).data.ticketStatus,'Waiting on us','Conversation-only resolution preserves the linked ticket.');
    // Restore the active thread so the following first-response tests exercise this reopened case.
    const resolvedAgain=await conversation();
    const claim=await ok(change({action:'claim',revision:resolvedAgain.conversation.revision}));
    await ok(change({action:'reopen',revision:claim.revision}));
  }finally{await browser.close();}
}

async function verifyTicketTagTriage({origin,workspaceId,identity,id,ticketId,sql,ok,detail,read,post,sharedApi,repId}){
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  const before=await detail(),ticket=await ok(read('/api/tickets?id='+ticketId));
  const edit={action:'tag_ticket',id,revision:before.conversation.revision,linkedTicket:{id:ticketId,revision:ticket.revision},tags:['Warranty']};
  assert.equal((await post('/api/team-inbox',edit)).status,409,'Even the owner must hold the conversation claim.');
  assert.equal((await post(sharedApi,{...edit,linkedTicket:{id:randomUUID(),revision:1}},identity)).status,409);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=identity.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?'+new URLSearchParams({view:'team-inbox',id,workspaceId}));
    await page.getByRole('button',{name:'Edit ticket tags'}).click();
    const field=page.getByLabel('Ticket tags, one per line');
    await field.fill('Warranty');
    await ok(post('/api/tickets',{action:'save',id:ticketId,expectedRevision:ticket.revision,data:{name:ticket.data.name,tags:['Service, west']}}));
    assert.equal((await post(sharedApi,edit,identity)).status,409,'The earlier ticket version cannot overwrite the other editor.');
    await page.getByRole('button',{name:'Reload ticket tags'}).click();
    assert.equal(await field.inputValue(),'service, west');
    await field.fill('service, west\nWarranty');
    await page.getByRole('button',{name:'Save ticket tags'}).click();
    await page.getByRole('link',{name:'Open conversations with ticket tag warranty'}).click();
    assert.equal(await page.getByLabel('Ticket tag',{exact:true}).inputValue(),'warranty');
    const match=page.getByRole('link',{name:before.conversation.subject,exact:true});
    await match.click();
    assert.equal(new URL(page.url()).searchParams.get('id'),id);
    await page.getByRole('link',{name:'Inbox',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('ticketTag'),'warranty');
    const sharedSearch='/api/team-inbox?'+new URLSearchParams({workspaceId,ticketTag:'WARRANTY'});
    assert.deepEqual((await ok(read(sharedSearch,identity))).items.map(row=>row.id),[id]);
    assert.deepEqual((await ok(read(sharedSearch+'&tag=warranty',identity))).items,[]);
    assert.deepEqual((await ok(read('/api/team-inbox?ticketTag=warranty',identity))).items,[]);
    const after=await detail();
    assert.deepEqual(after.conversation,before.conversation);
    assert.deepEqual(after.ticket.tags,['service, west','warranty']);
    assert.deepEqual(after.ticket.firstResponse,before.ticket.firstResponse);
    assert.equal(after.ticket.revision,ticket.revision+2);
    const [event]=await sql`SELECT actor_id,data->'data'->'tags' AS tags FROM portable_ticket_events
      WHERE workspace_id=${workspaceId} AND ticket_id=${ticketId} AND revision=${after.ticket.revision}`;
    assert.deepEqual(event,{actor_id:repId,tags:after.ticket.tags});
    await ok(post(sharedApi,{...edit,linkedTicket:{id:ticketId,revision:after.ticket.revision},tags:[...after.ticket.tags].reverse()},identity));
    assert.equal((await detail()).ticket.revision,after.ticket.revision);
  }finally{await browser.close();}
}
