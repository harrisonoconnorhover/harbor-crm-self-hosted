import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyInboxHandoff({sql,id,workspaceId,headers,other,owner,rep,specialistId,origin,detail,deliveries,write,asRep,reply,replyAuthor}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  async function open(identity,shared,viewport){
    const context=await browser.newContext({viewport});
    const [name,value]=identity.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();page.setDefaultTimeout(8000);
    await page.goto(origin+'/?view=team-inbox&id='+id+(shared?'&workspaceId='+workspaceId:''));
    return page;
  }
  async function prepareAssignment(page,to){
    await page.getByText('Assign to teammate',{exact:true}).click();
    await page.getByLabel('Teammate',{exact:true}).selectOption(to.id);
  }
  try{
    const desktop=await open(headers,false,{width:1440,height:900});
    const mobile=await open(other,true,{width:390,height:844});
    const starting=await detail(),sent=(await deliveries()).length;
    assert.equal(starting.conversation.claimedBy,owner.id);
    assert.equal(await mobile.getByText('Assign to teammate',{exact:true}).count(),0);
    assert.equal((await asRep('assign',starting.conversation.revision,{assigneeId:rep.id})).status,409);
    assert.equal((await write('assign',starting.conversation.revision,{assigneeId:randomUUID()})).status,409);
    const activity=desktop.waitForResponse(response=>response.request().method()==='POST'&&response.request().postDataJSON()?.action==='draft_activity');
    const ownerDraft=desktop.getByLabel(/^Reply to /);
    await ownerDraft.fill('Private unfinished reply');
    const receipt=await activity;
    assert.equal(receipt.status(),200);
    assert.deepEqual(receipt.request().postDataJSON(),{action:'draft_activity',id,revision:starting.conversation.revision});
    const typing=await detail();
    assert.ok(typing.recentDraftAt);
    assert.deepEqual(typing.conversation,starting.conversation);
    assert.deepEqual(typing.messages,starting.messages);
    assert.equal((await asRep('draft_activity',starting.conversation.revision)).status,409);
    assert.equal((await write('draft_activity',starting.conversation.revision,{body:'private'})).status,400);
    await mobile.getByText(/Last worked on a reply at/).waitFor({timeout:15000});
    assert.ok(!(await mobile.locator('body').innerText()).includes('Private unfinished reply'));
    await sql`UPDATE portable_inbox_conversations SET draft_activity_at=statement_timestamp()-interval '31 seconds'
      WHERE workspace_id=${workspaceId} AND id=${id}`;
    assert.equal((await detail()).recentDraftAt,null);
    await mobile.getByText(/Last worked on a reply at/).waitFor({state:'hidden',timeout:15000});
    assert.equal((await write('draft_activity',starting.conversation.revision)).status,200);
    const teamText='The replacement scanner passed its bench test.';
    const notePost=mobile.waitForRequest(req=>req.method()==='POST'&&req.url().includes('/api/team-inbox')&&req.postDataJSON().action==='note');
    await mobile.getByText('Add team note',{exact:true}).click();
    await mobile.getByLabel('Note for teammates').fill(teamText);
    await mobile.getByRole('button',{name:'Save team note',exact:true}).click();
    const {noteId,revision}=(await notePost).postDataJSON();
    const posted=desktop.locator('.inbox-msg.internal').filter({hasText:teamText});
    await posted.getByText('Team note',{exact:true}).waitFor({timeout:15000});
    await posted.getByText(rep.label,{exact:true}).waitFor();
    const before=await detail();
    assert.equal(before.recentDraftAt,null);
    assert.equal((await write('draft_activity',starting.conversation.revision)).status,409);
    assert.equal(before.conversation.claimedBy,owner.id);
    assert.equal(before.conversation.revision,starting.conversation.revision+1);
    assert.deepEqual(before.messages.filter(m=>m.id===noteId).map(m=>[m.direction,m.state,m.body]),[['internal','note',teamText]]);
    assert.ok(await desktop.getByRole('button',{name:'Send reply',exact:true}).isDisabled());
    assert.equal(await desktop.getByLabel(/^Reply to /).inputValue(),'Private unfinished reply');
    assert.equal((await asRep('note',revision,{noteId,body:teamText})).status,200);
    assert.equal((await asRep('note',revision,{noteId,body:'Different note'})).status,409);
    assert.equal((await write('note',revision,{noteId,body:teamText})).status,409);
    assert.equal((await detail()).conversation.revision,before.conversation.revision);
    await prepareAssignment(desktop,rep);
    assert.equal(await desktop.getByLabel('Handoff note (team only)').inputValue(),'');
    const note='Please check the replacement scanner before calling Avery.';
    await desktop.getByLabel('Handoff note (team only)').fill(note);
    assert.equal((await write('tag',before.conversation.revision,{tags:before.conversation.tags})).status,200);
    // A burst of focus/visibility events arrives before even the first GET can finish.
    const refreshCount=await desktop.evaluate(()=>{
      const original=window.fetch;
      let reads=0;
      window.fetch=(input,init)=>{
        const url=new URL(input,location.href);
        if(url.pathname==='/api/team-inbox'&&url.searchParams.has('id'))reads++;
        return original(input,init);
      };
      try{
        for(let i=0;i<3;i++){
          window.dispatchEvent(new Event('focus'));
          document.dispatchEvent(new Event('visibilitychange'));
        }
        return reads;
      }finally{window.fetch=original;}
    });
    assert.ok(refreshCount<=1,`Concurrent refresh signals started ${refreshCount} inbox reads.`);
    const reviewed=desktop.getByRole('button',{name:'Keep preparing handoff'});
    await reviewed.waitFor();
    assert.ok(await desktop.getByRole('button',{name:'Assign conversation'}).isDisabled());
    assert.equal(await desktop.getByLabel('Handoff note (team only)').inputValue(),note);
    await reviewed.click();
    await desktop.getByRole('button',{name:'Assign conversation'}).click();
    await desktop.locator('.inbox-details dd').filter({hasText:rep.label}).waitFor();
    await mobile.locator('.inbox-details dd[aria-live]').filter({hasText:/^You$/}).waitFor({timeout:12000});
    assert.equal(await desktop.getByLabel(/^Reply to /).inputValue(),'Private unfinished reply');
    assert.ok(await desktop.getByLabel(/^Reply to /).isDisabled());
    assert.equal(await mobile.getByLabel(/^Reply to /).inputValue(),'');
    assert.equal((await write('reply',before.conversation.revision,{replyId:randomUUID(),body:'Stale owner draft'})).status,409);
    const handed=await detail();
    assert.equal(handed.conversation.claimedBy,rep.id);
    const handoffs=handed.messages.filter(m=>m.body===note);
    assert.deepEqual(handoffs.map(m=>[m.direction,m.state,m.author,m.handoffToLabel]),[['internal','handoff',owner.label,rep.label]]);
    const entry=mobile.locator('.inbox-msg.internal').filter({hasText:note});
    await entry.getByText(owner.label+' assigned this conversation to '+rep.label+'.',{exact:true}).waitFor();
    assert.equal(await entry.getByRole('button').count(),0);
    assert.equal((await write('reply',handed.conversation.revision,{replyId:randomUUID(),body:'Former claimant'})).status,409);
    await mobile.getByLabel(/^Reply to /).fill('Draft for the next follow-up');
    await desktop.getByText(/Last worked on a reply at/).waitFor({timeout:15000});
    assert.equal((await write('draft_activity',handed.conversation.revision)).status,409);
    const newTab=mobile.context().waitForEvent('page');
    await mobile.getByRole('link',{name:'Team history (opens in a new tab)'}).click();
    const history=await newTab;
    await history.getByRole('heading',{name:'Team notes and handoffs'}).waitFor();
    assert.equal(new URL(history.url()).searchParams.get('workspaceId'),workspaceId);
    await history.locator('.inbox-msg.internal').filter({hasText:note})
      .getByText(owner.label+' assigned this conversation to '+rep.label+'.',{exact:true}).waitFor();
    await history.locator('.inbox-msg.internal').filter({hasText:teamText}).getByText(rep.label,{exact:true}).waitFor();
    assert.equal(await history.locator('.inbox-msg.incoming,.inbox-msg.outgoing').count(),0);
    assert.equal(await history.getByLabel(/^Reply to /).count(),0);
    const filters=history.getByRole('navigation',{name:'Team history filters'});
    await filters.getByRole('link',{name:'Handoffs',exact:true}).click();
    await history.locator('.inbox-msg.internal').filter({hasText:note}).waitFor();
    assert.equal(await history.locator('.inbox-msg').filter({hasText:teamText}).count(),0);
    await filters.getByRole('link',{name:'Notes',exact:true}).click();
    await history.locator('.inbox-msg.internal').filter({hasText:teamText}).waitFor();
    assert.equal(await history.locator('.inbox-msg').filter({hasText:note}).count(),0);
    await history.getByRole('link',{name:'All messages',exact:true}).click();
    await history.locator('.inbox-msg.incoming').first().waitFor();
    await history.close();
    assert.equal(await mobile.getByLabel(/^Reply to /).inputValue(),'Draft for the next follow-up');
    // A transfer cannot change the recorded author of an earlier reply, including one on an older page.
    const olderTab=mobile.context().waitForEvent('page');
    await mobile.getByRole('link',{name:'Older messages (opens in a new tab)',exact:true}).click();
    const older=await olderTab;
    await older.locator('.inbox-msg.outgoing').filter({hasText:reply.body}).getByText('Accepted for delivery · '+replyAuthor.label,{exact:true}).waitFor();
    assert.equal(new URL(older.url()).searchParams.get('workspaceId'),workspaceId);
    await older.close();
    const draft=mobile.getByLabel(/^Reply to /),teamNote=mobile.getByLabel('Handoff note (team only)');
    assert.equal(await draft.inputValue(),'Draft for the next follow-up');
    const longDraft='Please verify the serial number. '.repeat(75).trim();
    await draft.fill(longDraft);
    await prepareAssignment(mobile,owner);
    assert.equal(await teamNote.inputValue(),'');
    await mobile.getByRole('button',{name:'Copy reply draft into handoff note',exact:true}).click();
    assert.equal(await teamNote.inputValue(),longDraft);
    assert.ok(await mobile.getByRole('button',{name:'Assign conversation'}).isDisabled());
    const reviewedNote='Please verify the serial number with the customer.';
    await teamNote.fill(reviewedNote);
    assert.equal(await draft.inputValue(),longDraft);
    assert.equal(await mobile.getByRole('button',{name:'Copy reply draft into handoff note',exact:true}).count(),0);
    await mobile.getByRole('button',{name:'Assign conversation'}).click();
    await mobile.locator('.inbox-details dd').filter({hasText:owner.label}).waitFor();
    const returned=await detail();
    assert.equal(returned.conversation.claimedBy,owner.id);
    assert.deepEqual(returned.messages.filter(m=>m.body===reviewedNote).map(m=>[m.direction,m.state,m.author,m.handoffToLabel]),
      [['internal','handoff',rep.label,owner.label]]);
    assert.ok(returned.messages.every(m=>m.body!==longDraft));
    assert.equal((await deliveries()).length,sent);
    const candidates=['Inspect the cable first.','Inspect the power supply first.'];
    const simultaneous=await Promise.all(candidates.map(note=>write('assign',returned.conversation.revision,{assigneeId:rep.id,note})));
    const winner=simultaneous.findIndex(r=>r.status===200);
    assert.deepEqual(simultaneous.map(r=>r.status).sort(),[200,409]);
    const final=await detail();
    assert.equal(final.conversation.revision,returned.conversation.revision+1);
    assert.deepEqual(final.messages.filter(m=>candidates.includes(m.body)).map(m=>m.body),[candidates[winner]]);
    assert.equal((await write('create_ticket',final.conversation.revision)).status,409);
    assert.equal((await asRep('create_ticket',returned.conversation.revision)).status,409);
    await mobile.reload();
    // Simulate two submissions of the same rendered form reaching the server together.
    const responses=[];
    await mobile.route('**/api/team-inbox?**',async route=>{
      if(route.request().method()!=='POST'||route.request().postDataJSON().action!=='create_ticket')return route.continue();
      const [first,retry]=await Promise.all([route.fetch(),route.fetch()]);
      responses.push(await first.json(),await retry.json());
      await route.fulfill({response:first});
    });
    const priority=mobile.getByLabel('Ticket priority',{exact:true});
    assert.equal(await priority.inputValue(),'Medium');
    await priority.selectOption('High');
    await mobile.getByRole('button',{name:'Create ticket',exact:true}).click();
    await mobile.getByRole('link',{name:'Open linked ticket',exact:true}).waitFor();
    const working='Checking the customer’s open ticket.';
    await draft.fill(working);
    const caseTab=mobile.context().waitForEvent('page');
    await mobile.getByRole('link',{name:'Open linked ticket (opens in a new tab)',exact:true}).click();
    const casePage=await caseTab;
    await casePage.getByRole('heading',{name:final.conversation.subject,exact:true}).waitFor();
    assert.equal(new URL(casePage.url()).searchParams.get('workspaceId'),workspaceId);
    await casePage.close();
    assert.equal(await draft.inputValue(),working);
    await draft.fill('');
    await mobile.getByRole('link',{name:'Open linked ticket'}).click();
    const linked=await detail();
    assert.ok(linked.ticket.id);
    assert.deepEqual(responses.map(r=>r.ticketId),[linked.ticket.id,linked.ticket.id]);
    assert.equal(linked.conversation.revision,final.conversation.revision+1);
    assert.equal(new URL(mobile.url()).searchParams.get('workspaceId'),workspaceId);
    await mobile.getByRole('heading',{name:final.conversation.subject,exact:true}).waitFor();
    for(const tag of final.conversation.tags)await mobile.getByRole('link',{name:tag.toLowerCase(),exact:true}).waitFor();
    await mobile.getByRole('link',{name:'Open original conversation'}).click();
    assert.equal(new URL(mobile.url()).searchParams.get('id'),id);
    assert.equal(new URL(mobile.url()).searchParams.get('workspaceId'),workspaceId);
    assert.equal((await deliveries()).length,sent);
    await prepareAssignment(mobile,owner);
    await mobile.getByLabel('Also assign linked ticket').check();
    const updated=await desktop.request.post(origin+'/api/tickets',{headers:{origin},data:{action:'save',id:linked.ticket.id,
      expectedRevision:linked.ticket.revision,data:{name:final.conversation.subject,description:'Added during shift change'}}});
    assert.equal(updated.status(),200);
    const staleAssignment=await asRep('assign',linked.conversation.revision,{assigneeId:owner.id,
      linkedTicket:{id:linked.ticket.id,revision:linked.ticket.revision}});
    assert.equal(staleAssignment.status,409);
    assert.equal((await detail()).conversation.revision,linked.conversation.revision);
    await mobile.getByRole('button',{name:'Keep preparing handoff'}).click({timeout:15000});
    await mobile.getByRole('button',{name:'Assign conversation'}).click();
    await mobile.locator('.inbox-details dd[aria-live]').filter({hasText:owner.label}).waitFor();
    const assigned=await detail();
    assert.equal(assigned.ticket.assigneeId,owner.id);
    assert.equal(assigned.ticket.revision,linked.ticket.revision+2);
    assert.deepEqual(assigned.ticket.firstResponse,linked.ticket.firstResponse);
    // A conversation-only return leaves the linked ticket with the covering owner.
    assert.equal((await write('assign',assigned.conversation.revision,{assigneeId:rep.id})).status,200);
    const returnedAlone=await detail();
    assert.equal(returnedAlone.conversation.claimedBy,rep.id);
    assert.equal(returnedAlone.ticket.assigneeId,owner.id);
    assert.equal(returnedAlone.ticket.revision,assigned.ticket.revision);
    // Keep the mailbox with support while a record-scoped specialist takes the ticket.
    await mobile.reload();
    await mobile.getByText('Reassign ticket',{exact:true}).click();
    const specialistPicker=mobile.getByRole('combobox',{name:'Ticket assignee',exact:true});
    assert.match(await specialistPicker.locator('option[value="'+specialistId+'"]').innerText(),/invitee@example.test/);
    await specialistPicker.selectOption(specialistId);
    const ticketOnly={ticketId:returnedAlone.ticket.id,ticketRevision:returnedAlone.ticket.revision,assigneeId:specialistId};
    assert.equal((await asRep('assign',returnedAlone.conversation.revision,{assigneeId:specialistId})).status,409);
    assert.equal((await asRep('assign_ticket',returnedAlone.conversation.revision,{...ticketOnly,ticketId:randomUUID()})).status,409);
    const assignment=mobile.waitForResponse(response=>new URL(response.url()).pathname==='/api/team-inbox'&&response.request().method()==='POST'&&response.request().postDataJSON().action==='assign_ticket');
    await mobile.getByRole('button',{name:'Assign ticket',exact:true}).click();
    assert.equal((await assignment).status(),200);
    const changed=await detail();
    assert.deepEqual(changed.conversation,returnedAlone.conversation);
    assert.equal(changed.ticket.revision,returnedAlone.ticket.revision+1);
    assert.equal(changed.ticket.assigneeId,specialistId);
    assert.deepEqual(changed.ticket.firstResponse,returnedAlone.ticket.firstResponse);
    assert.equal((await asRep('assign_ticket',changed.conversation.revision,ticketOnly)).status,409);
    assert.equal((await deliveries()).length,sent);
    return {handoffId:handoffs[0].id,noteId};
  }finally{await browser.close();}
}
