import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Pass a private fictional contact; the fixture enrolls it and stops each test run.
export async function verifySalesSequenceBrowser({origin,headers,contactId}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME,headless:true});
  try{
    for(const width of [375,1440]){
      const context=await browser.newContext({viewport:{width,height:800}});
      const [name,value]=headers.cookie.split('=');
      await context.addCookies([{name,value,url:origin}]);
      const page=await context.newPage();
      page.setDefaultTimeout(10000);
      const title='Fictional cadence '+width+' '+randomUUID().slice(0,8);
      await page.goto(origin+'/?view=sequences');
      await page.getByRole('button',{name:'New sequence',exact:true}).click();
      await page.getByLabel('Sequence name',{exact:true}).fill(title);
      const first=page.getByRole('group',{name:'Step 1',exact:true});
      await first.getByLabel('Channel').selectOption('Call');
      await first.getByLabel('Task title').fill('Discuss the proposal');
      await page.getByRole('button',{name:'Add step'}).click();
      const second=page.getByRole('group',{name:'Step 2',exact:true});
      await second.getByLabel('Channel').selectOption('LinkedIn');
      await second.getByLabel('Task title').fill('Review the introduction');
      await second.getByLabel('Delay (days)').fill('2');
      await second.getByRole('combobox',{name:/^Deadline\b/}).selectOption('timed');
      await second.getByLabel('Minutes after assignment').fill('30');
      await second.getByLabel('In-app reminder').selectOption('5');
      await second.getByRole('button',{name:'Move step 2 up'}).click();
      assert.equal(await first.getByLabel('Task title').inputValue(),'Review the introduction');
      await page.getByRole('button',{name:'Save sequence'}).click();
      await page.getByText('Sequence saved.',{exact:true}).waitFor();

      // Read back the saved definition through the library before enrolling.
      while(!await page.getByRole('button',{name:title,exact:true}).count()){
        await page.getByRole('list',{name:'Saved sequences'}).waitFor();
        if(await page.getByRole('button',{name:title,exact:true}).count())break;
        await page.getByRole('button',{name:'Next sequences'}).click();
      }
      await page.getByRole('button',{name:title}).click();
      await first.getByLabel('Task title').waitFor();
      assert.equal(await first.getByLabel('Delay (days)').inputValue(),'2');
      assert.equal(await first.getByLabel('Minutes after assignment').inputValue(),'30');
      assert.equal(await first.getByLabel('In-app reminder').inputValue(),'5');

      await page.goto(origin+'/?contact='+encodeURIComponent(contactId));
      const card=page.getByRole('region',{name:'Sales sequences',exact:true});
      await card.getByRole('button',{name:'Enroll in sequence',exact:true}).click();
      const select=card.getByRole('combobox',{name:'Sequence',exact:true});
      await select.waitFor();
      while(!await select.getByRole('option',{name:title,exact:true}).count()){
        await card.getByRole('button',{name:'Next sequences'}).click();
        await select.waitFor();
      }
      await select.selectOption({label:title});
      const sequenceId=await select.inputValue();
      const partial=width===375;
      if(partial)await card.getByLabel('Start at step').selectOption({index:1});
      await card.getByRole('button',{name:'Review enrollment'}).click();
      await card.getByText('Discuss the proposal',{exact:true}).waitFor();
      if(partial){
        await card.getByText('Start at step 2. Earlier steps will be skipped.').waitFor();
        assert.equal(await card.getByText('Review the introduction',{exact:true}).count(),0);
      }else{
        await card.getByText('Review the introduction',{exact:true}).waitFor();
        await card.getByText('Due 30 minutes after assignment · Reminder 5 minutes before',{exact:true}).waitFor();
      }
      assert.ok(await card.getByText('Task assignee',{exact:true}).isVisible());
      const geometry=await card.boundingBox();
      assert.ok(geometry&&geometry.x>=0&&geometry.x+geometry.width<=width+1,'Contact panel fits viewport');
      if(partial){
        // Another owner session replaces the chosen step while the review is open.
        const api=origin+'/api/sequences';
        const {sequence}=await (await page.request.get(api+'?sequenceId='+sequenceId)).json();
        const replacement=randomUUID();
        const revision=await page.request.post(api,{headers:{origin},data:{action:'save',id:sequence.id,name:sequence.name,
          expectedRevision:sequence.revision,steps:[sequence.steps[0],{...sequence.steps[1],id:replacement}]}});
        assert.ok(revision.ok(),await revision.text());
        await card.getByRole('button',{name:'Confirm enrollment'}).click();
        await card.getByRole('alert').filter({hasText:/sequence changed/i}).waitFor();
        await card.getByRole('button',{name:'Back',exact:true}).click();
        await card.getByRole('option',{name:'Choose a current step'}).waitFor({state:'attached'});
        assert.ok(await card.getByRole('button',{name:'Review enrollment'}).isDisabled());
        await card.getByLabel('Start at step').selectOption(replacement);
        await card.getByRole('button',{name:'Review enrollment'}).click();
      }
      await card.getByRole('button',{name:'Confirm enrollment'}).click();
      await card.getByText('Contact enrolled.',{exact:true}).waitFor();
      if(partial){
        await card.getByText('Started at step 2. Earlier steps were skipped.').waitFor();
        assert.equal(await card.locator('article ol').getAttribute('start'),'2');
        assert.equal(await card.locator('article ol li').count(),1);
      }
      await card.getByRole('button',{name:'Stop enrollment',exact:true}).click();
      await card.getByRole('button',{name:'Confirm stop'}).click();
      await card.locator('article').getByText('Stopped',{exact:true}).first().waitFor();
      await context.close();
    }
  }finally{await browser.close();}
}

export async function completeAssignedOutreach({origin,headers,workspaceId,task,profile,taskName,summary}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    await page.goto(origin+'/?view=sales-workspace&workspaceId='+workspaceId);
    await page.getByRole('link',{name:'LinkedIn 1',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('taskType'),'LinkedIn');
    await page.getByRole('table').getByRole('link',{name:taskName,exact:true}).waitFor();
    await page.getByRole('button',{name:'Task reminders',exact:true}).click();
    await page.getByRole('region',{name:'Task reminders'}).getByRole('link',{name:taskName,exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('record'),task.id);
    assert.equal(new URL(page.url()).searchParams.get('workspaceId'),workspaceId);
    const linkedIn=page.getByRole('link',{name:'Open River Example on LinkedIn',exact:true});
    assert.equal(await linkedIn.getAttribute('href'),profile);
    assert.equal(await linkedIn.getAttribute('target'),'_blank');
    await page.getByText('Log outreach and complete task',{exact:true}).click();
    assert.equal(await page.getByLabel('Outreach channel').inputValue(),'LinkedIn');
    await page.getByRole('button',{name:'Log outreach and complete',exact:true}).click();
    await page.getByText('Enter what happened before logging outreach.',{exact:true}).waitFor();
    await page.getByLabel('What happened?').fill(summary);
    const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/crm'&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Log outreach and complete',exact:true}).click();
    const result=await saved;
    assert.equal(result.status(),200,await result.text());
    const payload=await result.json();assert.equal(payload.record.id,task.id);assert.ok(payload.record.completedAt);
  }finally{await browser.close();}
}

export async function logOutlookSequenceReply({origin,headers,contactId,through,afterLogging}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.setDefaultTimeout(10000);
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    const record=origin+'/?contact='+contactId;
    await page.goto(record);
    const outlook=page.getByRole('region',{name:'Outlook history'});
    await outlook.getByLabel('Ending on (UTC)').fill(through);
    await outlook.getByRole('button',{name:'Search Outlook'}).click();
    await outlook.getByRole('listitem').filter({hasText:'Proposal from contact'}).getByRole('button',{name:'Log email'}).click();
    await outlook.getByText('Email logged on this contact.',{exact:true}).waitFor();
    await afterLogging(async()=>{
      await outlook.getByRole('button',{name:'Search Outlook'}).click();
      await outlook.getByRole('button',{name:'Confirm reply for sequences'}).click();
      await outlook.getByText('Reply confirmed for sales sequences.',{exact:true}).waitFor();
    });
    await page.reload();
    const card=page.getByRole('region',{name:'Sales sequences',exact:true});
    await card.getByRole('button',{name:'View enrollments'}).click();
    await card.getByRole('listitem').filter({hasText:'Stopped'}).getByRole('button').click();
    await card.locator('article').getByText('A received Outlook message was logged for this contact.',{exact:true}).first().waitFor();
  }finally{await browser.close();}
}

export async function reviewUncertainEnrollment({origin,headers,id,contactId,jobId}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.setDefaultTimeout(10000);
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?view=sequences');
    await page.getByRole('link',{name:'Enrollments',exact:true}).click();
    const queue=page.getByRole('region',{name:'Enrollment queue'});
    await queue.getByRole('link',{name:'Unavailable assignees'}).click();
    const row=queue.getByRole('listitem').filter({hasText:'River Example'});
    await row.getByText(/Delivery is unconfirmed/).waitFor();
    await row.getByRole('link').click();
    assert.equal(new URL(page.url()).searchParams.get('enrollmentId'),id);
    const receipt=page.locator('article.portable-sequence-receipt');
    assert.equal(await receipt.getByRole('link',{name:'River Example'}).getAttribute('href'),'/?contact='+contactId);
    await receipt.getByRole('link',{name:'Contact access history'}).click();
    assert.equal(new URL(page.url()).searchParams.get('record'),contactId);
    await page.getByRole('row').filter({hasText:'owner@example.test'}).filter({hasText:'Linked record preview'}).first().waitFor();
    await page.goBack();
    await receipt.getByRole('link',{name:/^Email job/}).click();
    assert.equal(new URL(page.url()).searchParams.get('jobId'),jobId);
    await page.getByText(jobId,{exact:true}).waitFor();
    await page.getByRole('button',{name:'Mark reviewed'}).waitFor();
    await page.goBack();
    await receipt.getByRole('button',{name:'Stop enrollment'}).click();
    await receipt.getByText(/will still need review in Job queue/).waitFor();
    await receipt.getByRole('button',{name:'Confirm stop'}).click();
    await receipt.getByText('Stopped',{exact:true}).first().waitFor();
    await page.getByRole('link',{name:'Back to needs attention enrollments'}).click();
    await queue.getByText('No enrollments with unavailable assignees on this page.').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('assignee'),'unavailable');
    await queue.getByRole('link',{name:'Stopped',exact:true}).click();
    await queue.getByRole('link',{name:/River Example/}).first().waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }finally{await browser.close();}
}
