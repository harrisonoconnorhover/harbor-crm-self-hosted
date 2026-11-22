import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';

// Optional real-browser fixture. Both the publisher and Harbor run on local, distinct origins.
export async function verifyAttributionBrowser({origin,headers,request,mapDomain,sql}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME,headless:true});
  const form=randomUUID();
  let site;
  const publisher=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    res.end('<!doctype html><title>Fictional studio</title><script defer src="'+origin+'/journey.js" data-site="'+site+
      '" data-paths="/,/demo"></script><button onclick="HarborJourney.start()">Allow analytics</button>'+
      '<a href="/demo?utm_source=partner&amp;utm_campaign=demo-day&amp;utm_medium=referral">Studio demo</a>'+
      (path==='/demo'?'<iframe title="Studio inquiry" src="'+origin+'/forms/'+form+'"></iframe>':''));
  });
  try{
    publisher.listen(0,'127.0.0.1');await once(publisher,'listening');
    const publisherOrigin='http://127.0.0.1:'+publisher.address().port;
    const owner=await browser.newContext({viewport:{width:1400,height:900}});
    const [name,value]=headers.cookie.split('=');
    await owner.addCookies([{name,value,url:origin}]);
    const admin=await owner.newPage();admin.setDefaultTimeout(8000);
    await admin.goto(origin+'/?view=web-attribution');
    await admin.getByRole('link',{name:'Tracking sites',exact:true}).click();
    const add=admin.getByRole('button',{name:'Add tracking site',exact:true});
    if(await add.count())await add.click();
    await admin.getByLabel('Site name').fill('Fictional studio');
    await admin.getByLabel('Website origin').fill(publisherOrigin);
    await admin.getByRole('button',{name:'Add site',exact:true}).click();
    await admin.getByRole('button',{name:'Pause tracking'}).waitFor();
    const report=async()=>{const r=await request('/api/web-attribution',{headers});assert.ok(r.ok);return r.json();};
    site=(await report()).sites.find(s=>s.origin===publisherOrigin).id;
    async function formWrite(data){
      const r=await request('/api/lead-forms',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(data)});
      assert.ok(r.ok,await r.text());
    }
    await formWrite({action:'save',id:form,revision:0,definition:{title:'Studio consultation',embedOrigin:publisherOrigin,captureContacts:true}});
    await formWrite({action:'setEnabled',id:form,revision:1,enabled:true});
    const visitor=await browser.newContext({viewport:{width:390,height:844}});
    const page=await visitor.newPage();page.setDefaultTimeout(8000);
    const events=[];page.on('request',r=>{if(r.url().includes('/api/public/journey?'))events.push(r.url());});
    await page.goto(publisherOrigin+'/?utm_source=newsletter&utm_campaign=open-day&utm_medium=email');
    await page.waitForFunction(()=>!!window.HarborJourney);
    assert.equal(events.length,0);
    async function consent(){
      const sent=page.waitForResponse(r=>r.url().includes('/api/public/journey?')&&r.request().method()==='POST');
      await page.getByRole('button',{name:'Allow analytics'}).click();
      assert.equal((await sent).status(),202);
    }
    await consent();
    await page.getByRole('link',{name:'Studio demo'}).click();
    await consent();
    const frame=page.frameLocator('iframe');
    await frame.getByLabel('Name',{exact:true}).fill('Studio visitor');
    await frame.getByLabel('Email address').fill('studio-browser@example.test');
    await frame.getByRole('button',{name:'Send inquiry'}).click();
    await frame.getByText('Thank you. Your inquiry has been received.').waitFor();
    await admin.goto(origin+'/?view=web-attribution&siteId='+site);
    await admin.getByRole('link',{name:'Traffic',exact:true}).click();
    const period=admin.getByLabel('Reporting period',{exact:true});
    await period.selectOption('previous7d');
    await admin.getByText('No measured visits in this period.').waitFor();
    await admin.getByRole('link',{name:'Web attribution',exact:true}).click();
    assert.equal(await period.inputValue(),'previous7d');
    await admin.getByText('No attributed inquiries in this period.').waitFor();
    await period.selectOption('7d');
    await admin.getByRole('link',{name:'Studio consultation'}).waitFor();
    await admin.getByRole('link',{name:'Traffic',exact:true}).click();
    assert.equal(await period.inputValue(),'7d');
    const traffic=admin.getByRole('table',{name:'Website traffic'});
    await traffic.getByRole('rowheader',{name:'newsletter'}).waitFor();
    assert.equal(new URL(admin.url()).searchParams.get('siteId'),site);
    await admin.getByLabel('Group visits by').selectOption('page');
    await traffic.getByRole('rowheader',{name:publisherOrigin+'/demo',exact:true}).waitFor();
    await admin.reload();
    assert.equal(await admin.getByLabel('Group visits by').inputValue(),'page');
    await admin.getByLabel('Group visits by').selectOption('campaign');
    await traffic.getByRole('rowheader',{name:'open-day',exact:true}).waitFor();
    const allSites=admin.getByLabel('Website',{exact:true});
    await allSites.selectOption('');
    await traffic.getByRole('rowheader',{name:'open-day',exact:true}).waitFor();
    await allSites.selectOption(site);
    await admin.getByRole('link',{name:'Web attribution',exact:true}).click();
    const group=admin.getByLabel('Group credit by');
    await group.selectOption('Campaign');
    const table=admin.getByRole('table');
    assert.deepEqual(await table.getByRole('row',{name:/^open-day /}).getByRole('cell').allTextContents(),['1','0','0.5']);
    assert.deepEqual(await table.getByRole('row',{name:/^demo-day /}).getByRole('cell').allTextContents(),['0','1','0.5']);
    await period.selectOption('24h');
    await admin.getByRole('heading',{name:'Campaign credit'}).waitFor();
    assert.equal(await group.inputValue(),'Campaign');
    await period.selectOption('7d');
    await admin.getByRole('heading',{name:'Campaign credit'}).waitFor();
    await group.selectOption('Medium');
    assert.deepEqual(await table.getByRole('row',{name:/^email /}).getByRole('cell').allTextContents(),['1','0','0.5']);
    await admin.getByRole('link',{name:'Studio consultation'}).click();
    await admin.getByRole('heading',{name:'Path to inquiry'}).waitFor();
    assert.equal(new URL(admin.url()).searchParams.get('period'),'7d');
    assert.ok((await admin.getByRole('link',{name:'All conversion paths'}).getAttribute('href')).includes('period=7d'));
    assert.deepEqual(await admin.locator('.journey-path strong').allTextContents(),['/','/demo']);
    await admin.getByRole('link',{name:'Open form inquiry',exact:true}).click();
    await admin.getByRole('link',{name:'View conversion path'}).click();
    await admin.getByRole('heading',{name:'Path to inquiry'}).waitFor();
    const results=await (await request('/api/web-attribution?siteId='+site,{headers})).json();
    assert.equal(results.pageviews,2);assert.equal(results.conversions,1);
    assert.deepEqual(results.sources.map(s=>Number(s.linear)).sort(),[0.5,0.5]);
    console.log('Desktop owner created a site; mobile visitor consented, browsed two campaign sources and submitted an embedded form; owner saw the path and shared credit.');
    async function write(path,data){
      const res=await request(path,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(data)});
      assert.ok(res.ok,await res.clone().text());
      return res.json();
    }
    const id=randomUUID();
    const landing=await write('/api/landing-pages',{action:'save',id,revision:0,draft:{
      title:'Studio open day',slug:'home',description:'Join the open day.',accent:'#14726a',
      blocks:[{id:randomUUID(),type:'form',label:'Visit the studio',formId:form}]
    }});
    await write('/api/landing-pages',{action:'publish',id,revision:landing.revision});
    const domain=await mapDomain(landing.workspaceId),mappedSite=randomUUID();
    await write('/api/web-attribution',{id:mappedSite,name:'Open day',origin:domain,enabled:true,revision:0});
    const landingPage=await visitor.newPage();
    landingPage.setDefaultTimeout(8000);
    const collected=[];
    landingPage.on('request',r=>{if(r.url().includes('/api/public/journey?'))collected.push(r.url());});
    await landingPage.goto(domain+'/?utm_source=studio-day');
    const allow=landingPage.getByRole('button',{name:'Allow visit measurement'});
    await allow.waitFor();
    assert.equal(collected.length,0);
    const received=landingPage.waitForResponse(r=>r.url().includes('/api/public/journey?')&&r.request().method()==='POST');
    await allow.click();assert.equal((await received).status(),202);
    await landingPage.getByRole('link',{name:'Visit the studio'}).click();
    await landingPage.getByLabel('Name',{exact:true}).fill('Open day visitor');
    await landingPage.getByLabel('Email address').fill('studio-open-day@example.test');
    await landingPage.getByRole('button',{name:'Send inquiry'}).click();
    await landingPage.getByText('Thank you. Your inquiry has been received.').waitFor();
    const mappedReport=await (await request('/api/web-attribution?siteId='+mappedSite,{headers})).json();
    assert.equal(mappedReport.conversions,1);
    assert.equal(mappedReport.sources[0].source,'studio-day');
    // Two forms and two contacts. Open the first Contact from its path, then follow its scoped report back.
    await admin.getByRole('link',{name:'Open contact',exact:true}).click();
    const contactId=new URL(admin.url()).searchParams.get('contact');
    assert.ok(contactId);
    await admin.getByRole('link',{name:'View conversion paths',exact:true}).click();
    await admin.getByRole('link',{name:'Studio visitor',exact:true}).waitFor();
    assert.deepEqual(await admin.locator('.journey-metrics dt').allTextContents(),['Attributed form inquiries']);
    assert.deepEqual((await admin.locator('.journey-conversions a').allTextContents()).map(label=>label.trim()),['Studio consultation']);
    assert.equal((await request('/api/web-attribution?'+new URLSearchParams({contactId,inquiryId:mappedReport.recent[0].inquiryId}),{headers})).status,404);
    await group.selectOption('Campaign');
    await period.selectOption('7d');
    await admin.getByRole('link',{name:'Studio consultation'}).click();
    await admin.getByRole('heading',{name:'Path to inquiry'}).waitFor();
    assert.deepEqual(await admin.locator('.journey-path strong').allTextContents(),['/','/demo']);
    await admin.getByRole('link',{name:'All conversion paths'}).click();
    assert.equal(new URL(admin.url()).searchParams.get('contactId'),contactId);
    assert.equal(await group.inputValue(),'Campaign');
    await admin.getByRole('link',{name:'Show all contacts'}).click();
    assert.ok((await admin.locator('.journey-conversions a').count())>=2);
    await landingPage.goto(domain+'/');
    await landingPage.getByRole('button',{name:'Stop visit measurement'}).click();
    await landingPage.reload();await allow.waitFor();
    const afterWithdrawal=collected.length;
    await landingPage.goto(domain+'/?utm_source=withdrawn');await allow.waitFor();
    assert.equal(collected.length,afterWithdrawal);
    console.log('A visitor on a Harbor custom-domain landing page opted in, submitted a linked form and withdrew consent. The owner saw the attributed conversion.');
    // Equal timestamps span two page boundaries; the UUID fixes the order within each tie.
    const seed=results.recent[0];
    async function addConversions(count,at){
      const rows=await sql`WITH inquiries AS (
        INSERT INTO portable_lead_inquiries(workspace_id,id,form_id,received_at,status,payload)
        SELECT workspace_id,gen_random_uuid(),form_id,${at},'inbox_only',payload
        FROM portable_lead_inquiries CROSS JOIN generate_series(1,${count}::int) WHERE id=${seed.inquiryId}
        RETURNING workspace_id,id
      ) INSERT INTO portable_form_conversions(workspace_id,inquiry_id,site_id,converted_at,total,first_source,last_source,counts,utm_counts,path)
      SELECT i.workspace_id,i.id,c.site_id,${at},c.total,c.first_source,c.last_source,c.counts,c.utm_counts,c.path
      FROM inquiries i JOIN portable_form_conversions c ON c.workspace_id=i.workspace_id AND c.inquiry_id=${seed.inquiryId}
      RETURNING inquiry_id`;
      return rows.map(row=>row.inquiry_id);
    }
    const expected=[seed.inquiryId,...await addConversions(50,seed.convertedAt)].sort().reverse();
    await admin.goto(origin+'/?view=web-attribution&siteId='+site+'&period=7d');
    const inquiries=admin.locator('.journey-conversions a');
    const ids=()=>inquiries.evaluateAll(links=>links.map(a=>new URL(a.href).searchParams.get('inquiryId')));
    const total=admin.locator('.journey-metrics div').filter({hasText:'Attributed form inquiries'}).locator('dd');
    assert.deepEqual(await ids(),expected.slice(0,25));
    const older=admin.getByRole('link',{name:'Older inquiries'});
    const through=Number(new URL(await older.getAttribute('href'),origin).searchParams.get('through'));
    await addConversions(1,through+1);
    await older.click();
    assert.deepEqual(await ids(),expected.slice(25,50));
    assert.equal(await total.textContent(),'51');
    await group.selectOption('Campaign');
    const middle=admin.url();
    await admin.reload();
    assert.equal(await group.inputValue(),'Campaign');
    await inquiries.first().click();
    assert.deepEqual(await admin.locator('.journey-path strong').allTextContents(),['/','/demo']);
    await admin.getByRole('link',{name:'All conversion paths'}).click();
    assert.equal(admin.url(),middle);
    await older.click();
    assert.deepEqual(await ids(),expected.slice(50));
    assert.equal(await older.count(),0);
    const lastPage=admin.url();
    await inquiries.first().click();
    await admin.getByRole('link',{name:'Open form inquiry',exact:true}).click();
    await admin.getByRole('heading',{name:'Form inquiry',exact:true}).waitFor();
    assert.equal(new URL(admin.url()).searchParams.get('submissionId'),expected.at(-1));
    assert.equal(await admin.getByRole('link',{name:'View conversion path'}).count(),1);
    await admin.getByRole('link',{name:'View conversion path'}).click();
    assert.equal(new URL(admin.url()).searchParams.get('inquiryId'),expected.at(-1));
    await admin.goto(lastPage);
    await admin.getByRole('link',{name:'Newest inquiries'}).click();
    assert.equal(await total.textContent(),'52');
  }finally{await browser.close();publisher.closeAllConnections();await new Promise(resolve=>publisher.close(resolve));}
}
