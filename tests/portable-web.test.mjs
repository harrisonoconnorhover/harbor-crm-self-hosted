import {verifyPortableContactArchive} from './portable-contact-archive-fixture.mjs';
import {verifyPortableCompanyArchive} from './portable-company-archive-fixture.mjs';
import {verifyPortableDealArchive} from './portable-deal-archive-fixture.mjs';
import {verifyPortableSharedArchive} from './portable-shared-archive-fixture.mjs';
import {verifyPortableBulkActions} from './portable-bulk-actions-fixture.mjs';
import {verifyPortableBulkProperties} from './portable-bulk-properties-fixture.mjs';
import {verifyPortableBulkStage} from './portable-bulk-stage-fixture.mjs';
import {verifyPortableCompanyMerge} from './portable-company-merge-fixture.mjs';
import {verifyPortableContactMerge} from './portable-contact-merge-fixture.mjs';
import {verifyPortableDuplicates} from './portable-duplicates-fixture.mjs';
import {verifyPortableSharedLeads} from './portable-shared-leads-fixture.mjs';
import {verifyPortableReportCustomFilters} from './portable-report-custom-filter-fixture.mjs';
import {verifyPortableContactArchiveReads} from './portable-contact-archive-reads-fixture.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {exportJWK,generateKeyPair,SignJWT} from 'jose';
import postgres from 'postgres';
import {verifyPortableCalendar,verifyPortableInvites,verifyPortableCancellations,verifyPortableReschedules,verifyPortableCalendarMonitor,portableCalendarFixture} from './portable-calendar-fixture.mjs';
import {verifyGuestBooking,verifyGuestStatusRead} from './guest-booking-fixture.mjs';
import {verifyPublishedAvailability} from './published-availability-fixture.mjs';
import {verifyPortableBookingPagination} from './portable-booking-pagination-fixture.mjs';
import {verifyPortableGmailDisabled,verifyPortableScheduledGmail} from './portable-gmail-fixture.mjs';
import {verifyPortableEmailTemplates} from './portable-email-templates-fixture.mjs';
import {outlookFixture,verifyOutlookConnections} from './portable-outlook-connection-fixture.mjs';
import {verifyOutlookRecords} from './portable-outlook-records-fixture.mjs';
import {personalGoogleFixture,verifyPersonalGoogle} from './portable-google-fixture.mjs';
import {portableInboxFixture,verifyPortableInbox} from './portable-gmail-inbox-fixture.mjs';
import {verifyPortableJobOperations,verifyPortableNoteRetry} from './portable-job-operations-fixture.mjs';
import {verifyPortableEmailSuppression} from './portable-email-suppression-fixture.mjs';
import {verifyPortableContactCreatedWorkflow,verifyPortableContactOwnerWorkflow,verifyPortableLifecycleWorkflow,verifyPortableStageWorkflows} from './portable-workflows-fixture.mjs';
import {verifyPortableTaskQueues} from './portable-task-queues-fixture.mjs';
import {verifyPortableTaskRepeats} from './portable-task-repeats-fixture.mjs';
import {verifyPortableCodeDisabled,verifyPortableCodeWorkflow} from './portable-code-workflow-fixture.mjs';
import {verifyPortableManualNoteBatch} from './portable-manual-note-batch-fixture.mjs';
import {verifyPortableManualWorkflow} from './portable-manual-workflow-fixture.mjs';
import {verifyPortableTaskWorkflow} from './portable-task-workflow-fixture.mjs';
import {verifyPortableIntake} from './portable-lead-intake-fixture.mjs';
import {verifyPortableBoard} from './portable-board-fixture.mjs';
import {verifyPortablePipelines} from './portable-pipelines-fixture.mjs';
import {verifyPortableDealStageProperties} from './portable-deal-stage-properties-fixture.mjs';
import {verifyPortableSegments} from './portable-segments-fixture.mjs';
import {verifyPortableStaticSegments} from './portable-static-segments-fixture.mjs';
import {verifyPortableFormNotes} from './portable-form-note-fixture.mjs';
import {verifyLeadWebhook} from './lead-webhook-fixture.mjs';
import {verifyPortableSegmentWorkflow} from './portable-segment-workflow-fixture.mjs';
import {verifyPortableLeads} from './portable-leads-fixture.mjs';
import {verifyPortableReports} from './portable-reports-fixture.mjs';
import {verifyPortableManagerFollowUp} from './portable-manager-follow-up-fixture.mjs';
import {verifyPortableDashboards} from './portable-dashboards-fixture.mjs';
import {verifyPortableRecovery,verifyPortableRecoveryJourney,verifyPortableRailwayRollback} from './portable-recovery-fixture.mjs';
import {verifyPortableGuestSignIn} from './portable-guest-sign-in-fixture.mjs';
import {verifyPortableKnowledge,verifyPortableKnowledgeCategories} from './portable-knowledge-fixture.mjs';
import {verifyPortableMigrations,verifyPortableDoctor,verifyPortableHosting} from './portable-hosting-fixture.mjs';
import {verifyInstallAssets} from './install-assets-fixture.mjs';
import {verifyPortableContactOutreach,verifyPortableSharedOutreach} from './portable-contact-activity-fixture.mjs';
import {verifyPortableRecordActivities} from './portable-record-activity-fixture.mjs';
import {verifyPortableActivityMutations} from './portable-activity-mutations-fixture.mjs';
import {verifyPortableRecordOwners} from './portable-record-owner-fixture.mjs';
import {verifyPortableJobs,verifyPortableSharedNotes} from './portable-jobs-fixture.mjs';
import {localFileFixture,verifyPortableFiles} from './portable-files-fixture.mjs';
import {verifyPortableTaskReminders} from './portable-task-reminders-fixture.mjs';
import {verifyPortableBackupTeamAdministration} from './portable-team-administration-fixture.mjs';
import {verifyPortableSharing} from './portable-sharing-fixture.mjs';
import {checkStandalone} from '../scripts/check-standalone.mjs';
import {verifyPortableMemberSavedViews,verifyPortableSavedViews} from './portable-saved-views-fixture.mjs';
import {verifyPortableInvitations} from './portable-invitation-fixture.mjs';
import {verifyPortableRecordCsv} from './portable-record-csv-fixture.mjs';
import {verifyPortableAssociations} from './portable-associations-fixture.mjs';
import {verifyPortableRecordCorrections} from './portable-record-corrections-fixture.mjs';
import {verifyPortableContactImport} from './portable-contact-import-fixture.mjs';
import {verifyPortableQuotes} from './portable-quotes-fixture.mjs';
import {verifyPortableInvoices} from './portable-invoices-fixture.mjs';
import {verifyPortableLineItems} from './portable-line-items-fixture.mjs';
import {verifyPortableProducts} from './portable-products-fixture.mjs';
import {seedAdditionalImportRecovery,verifyPortableAdditionalImports} from './portable-additional-import-fixture.mjs';
import {verifyPortableTickets} from './portable-tickets-fixture.mjs';
import {verifyPortableTicketSla} from './portable-ticket-sla-fixture.mjs';
import {verifyPortableCustomProperties} from './portable-custom-properties-fixture.mjs';
import {verifyPortablePropertyGroups} from './portable-property-groups-fixture.mjs';
import {verifyPortableExternalApi} from './portable-external-api-fixture.mjs';
import {verifyPortableCrmSearch} from './portable-crm-search-fixture.mjs';

const database=process.env.HARBOR_TEST_POSTGRES_URL;
const timeout=Number(process.env.HARBOR_TEST_SUITE_TIMEOUT_MS||900_000);
if(!Number.isInteger(timeout)||timeout<120_000||timeout>900_000){
  throw Error('Set HARBOR_TEST_SUITE_TIMEOUT_MS between 120000 and 900000.');
}

test('Portable API failure route labels omit private path segments',{skip:!database},async()=>{
  const {portableApiFailureRoute}=await import('../runtime/portable-web.mjs');
  const id='00000000-0000-4000-8000-000000000001';
  assert.equal(portableApiFailureRoute('/api/crm'),'/api/crm');
  assert.equal(portableApiFailureRoute('/api/calendar/meetings'),'/api/calendar/meetings');
  assert.equal(portableApiFailureRoute('/api/v1/records/tasks/'+id),'records-api');
  assert.equal(portableApiFailureRoute('/api/v1/forms/'+id+'/inquiries'),'form-submission');
  assert.equal(portableApiFailureRoute('/api/public/availability/'+id),'guest-booking');
  assert.equal(portableApiFailureRoute('/api/crm/'+id+'/private-file-key'),'other-api');
});

test('Built Node web server isolates Postgres contacts and preserves sessions and records across restart',
  {skip:!database,timeout},async t=>{
    const address=new URL(database);
    assert.ok(['postgres:','postgresql:'].includes(address.protocol));
    assert.equal(address.hostname,'127.0.0.1');
    assert.match(address.pathname,/^\/harbor_identity_test(?:_[a-z0-9]+)?$/);
    const sql=postgres(database,{onnotice:()=>{}});
    const directory=await mkdtemp(join(tmpdir(),'harbor-web-fixture-'));
    let child,exited,logs,fixture;
    async function stop(){
      if(!child)return;
      child.kill();
      await exited;
      child=undefined;
    }
    try{
      const [existing]=await sql`SELECT to_regclass('public.login_identities') AS identities`;
      assert.equal(existing.identities,null,'Use an empty disposable identity database.');
      const socket=createServer().listen(0,'127.0.0.1');
      await once(socket,'listening');
      const port=socket.address().port;
      await new Promise(resolve=>socket.close(resolve));
      const origin='http://127.0.0.1:'+port;
      fixture=localFileFixture();
      const env={...process.env,...fixture?.env,PORT:String(port),DATABASE_URL:database,HARBOR_LOGIN_ORIGIN:origin,
        HARBOR_LOGIN_ALLOWED_EMAILS:'owner@example.test,other@example.test,invitee@example.test',HARBOR_LOGIN_GOOGLE_CLIENT_ID:'fixture-client',
        HARBOR_LOGIN_GOOGLE_CLIENT_SECRET:'fixture-secret',HARBOR_PORTABLE_GMAIL_ENABLED:'false',HARBOR_PORTABLE_WORKFLOW_GMAIL_ENABLED:'false',HARBOR_GOOGLE_FIXTURE:join(directory,'google.json')};
      const guestProofLog=join(directory,'guest-proof.jsonl');
      await writeFile(guestProofLog,'');
      env.HARBOR_TEST_GUEST_PROOF_LOG=guestProofLog;
      env.HARBOR_PUBLIC_PILOT_CONTACT=JSON.stringify({name:'Fictional Portable & Co',email:'privacy+portable@example.test'});
      const personalGoogle=personalGoogleFixture(directory);
      const mock=join(directory,'google.mjs'),calendar=await portableCalendarFixture(directory),inbox=portableInboxFixture(directory);
      env.HARBOR_PORTABLE_CODE_ENABLED='false';
      env.HARBOR_PORTABLE_CALENDAR_ENABLED='false';
      env.HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED='false';
      env.HARBOR_PORTABLE_CALENDAR_INVITES_ENABLED='false';
      await writeFile(mock,`
        import assert from 'node:assert/strict';
        import {createHash} from 'node:crypto';
        import {readFile,appendFile} from 'node:fs/promises';
        import {readGuestMail} from ${JSON.stringify(new URL('./guest-booking-fixture.mjs',import.meta.url).href)};
        import {calendarFetch} from ${JSON.stringify(calendar.path)};
        import {inboxFetch} from ${JSON.stringify(new URL('./portable-gmail-inbox-fixture.mjs',import.meta.url).href)};
        import {personalGoogleFetch} from ${JSON.stringify(new URL('./portable-google-fixture.mjs',import.meta.url).href)};
        import {outlookConnectionFetch} from ${JSON.stringify(new URL('./portable-outlook-connection-fixture.mjs',import.meta.url).href)};
        import {outlookRecordsFetch} from ${JSON.stringify(new URL('./portable-outlook-records-fixture.mjs',import.meta.url).href)};
        const original=globalThis.fetch;
        globalThis.fetch=async (resource,options)=>{
          const url=new URL(resource);
          if(url.origin===process.env.HARBOR_LOGIN_ORIGIN)return original(resource,options);
          if(url.href==='https://oauth2.googleapis.com/token'&&options?.body?.get('refresh_token')==='guest-proof-refresh'){
            return Response.json({access_token:'guest-proof-access',expires_in:3600,token_type:'Bearer'});
          }
          if(new Headers(options?.headers).get('authorization')==='Bearer guest-proof-access'){
            assert.equal(url.origin,'https://gmail.googleapis.com');
            if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'owner@example.test'});
            assert.equal(url.pathname,'/gmail/v1/users/me/messages/send');
            await appendFile(process.env.HARBOR_TEST_GUEST_PROOF_LOG,JSON.stringify(readGuestMail(options))+'\\n');
            throw TypeError('Fictional Gmail accepted a code and lost the receipt');
          }
          const outlook=await outlookConnectionFetch(url,options)??await outlookRecordsFetch(url,options);
          if(outlook)return outlook;
          const personal=await personalGoogleFetch(url,options);
          if(personal)return personal;
          const inbox=await inboxFetch(url,options);
          if(inbox)return inbox;
          const calendar=await calendarFetch(url,options);
          if(calendar)return calendar;
          const fixture=JSON.parse(await readFile(process.env.HARBOR_GOOGLE_FIXTURE,'utf8'));
          if(url.href==='https://oauth2.googleapis.com/token'){
            assert.equal(options.body.get('code'),'fixture-code');
            assert.equal(options.body.get('redirect_uri'),process.env.HARBOR_LOGIN_ORIGIN+'/auth/google/callback');
            assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'),fixture.challenge);
            return Response.json({id_token:fixture.token});
          }
          assert.equal(url.href,'https://www.googleapis.com/oauth2/v3/certs');
          return Response.json({keys:[fixture.jwk]});
        };
      `);
      const request=(path,options={})=>fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(3000),...options});
      const command=process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs';
      const cwd=process.env.HARBOR_TEST_PORTABLE_CWD;
      const fingerprint=(await readFile(new URL('../.harbor/portable-build/release.sha256',import.meta.url),'utf8')).trim();
      assert.match(fingerprint,/^[a-f0-9]{64}$/);
      await verifyPortableMigrations(env,sql,directory);
      async function start(expectedStatus=200){
        child=spawn(process.execPath,['--import',mock,command,'start'],{env,cwd,stdio:['ignore','pipe','pipe']});
        exited=once(child,'exit');
        logs='';
        child.stdout.on('data',chunk=>{logs+=chunk;});
        child.stderr.on('data',chunk=>{logs+=chunk;});
        for(let attempt=0;attempt<100;attempt++){
          if(child.exitCode!==null)break;
          const ready=await request('/auth/sign-in').catch(()=>null);
          if(ready){
            assert.equal(ready.status,expectedStatus,logs);
            assert.equal(ready.headers.get('x-harbor-build-fingerprint'),fingerprint);
            assert.equal(ready.headers.get('cache-control'),'no-store');
            const html=await ready.text();
            assert.match(html,expectedStatus===503?/Google sign-in needs configuration/:/Continue with Google/);
            const asset=html.match(/(?:href|src)="([^"]+\.css)"/)?.[1];
            assert.ok(asset,'Sign-in page must reference a built stylesheet');
            const css=await request(asset);
            assert.equal(css.status,200);
            assert.match(css.headers.get('content-type'),/text\/css/);
            return;
          }
          await delay(50);
        }
        assert.fail('Portable web server did not start. '+logs);
      }
      const clientSecret=env.HARBOR_LOGIN_GOOGLE_CLIENT_SECRET;
      const publicContact=env.HARBOR_PUBLIC_PILOT_CONTACT;
      try{
        env.HARBOR_LOGIN_GOOGLE_CLIENT_SECRET='';
        env.HARBOR_PUBLIC_PILOT_CONTACT='off';
        await start(503);
        const setupChecks=await checkStandalone('https://portable-setup.example.test',(url,options)=>{
          const target=new URL(url);
          return request(target.pathname+target.search,options);
        },fingerprint,{beforeGoogle:true,portable:true,checkReleaseReadiness:true});
        assert.equal(setupChecks.length,13);
        // This fixture serves a loopback callback through a synthetic HTTPS origin.
        // The hosted-mode fixture verifies the matching HTTPS callback.
        assert.deepEqual(setupChecks.filter(check=>!check.ok).map(check=>check.name),
          ['Google setup callback matches the public origin']);
        const pending=await (await request('/auth/sign-in?return_to=https%3A%2F%2Foutside.example.test')).text();
        assert.ok(pending.includes('<code>'+origin+'/auth/google/callback</code>'));
        assert.match(pending,/Contact the person who invited you/);
        assert.doesNotMatch(pending,/href="mailto:/);
        assert.match(pending,/<code>HARBOR_LOGIN_GOOGLE_CLIENT_SECRET<\/code>/);
        for(const value of ['HARBOR_LOGIN_GOOGLE_CLIENT_ID','HARBOR_LOGIN_ALLOWED_EMAILS',
          'outside.example.test',env.HARBOR_LOGIN_GOOGLE_CLIENT_ID,'owner@example.test']){
          assert.ok(!pending.includes(value));
        }
      }finally{
        await stop();
        env.HARBOR_LOGIN_GOOGLE_CLIENT_SECRET=clientSecret;
        env.HARBOR_PUBLIC_PILOT_CONTACT=publicContact;
      }
      await start();
      const signInHtml=await (await request('/auth/sign-in')).text();
      await verifyInstallAssets(request,signInHtml);
      assert.match(signInHtml.replaceAll('<!-- -->',''),/href="mailto:privacy\+portable@example\.test">Contact Fictional Portable &amp; Co<\/a>/);
      assert.doesNotMatch(signInHtml,/owner@example\.test|fixture-secret/);
      assert.ok(!signInHtml.includes('Setting up this installation?'));
      for(const [path,expected] of [
        ['/privacy',/Postgres holds identity, CRM and job records[\s\S]*Private S3-compatible storage/],
        ['/terms',/Review scheduled notes/],
      ]){
        assert.ok(signInHtml.includes('href="'+path+'"'));
        const notice=await request(path+'?email=query-contact@example.test',{headers:{'oai-authenticated-user-id':'forged-notice-user'}});
        assert.equal(notice.status,200);
        assert.equal(notice.headers.has('set-cookie'),false);
        assert.match(notice.headers.get('cache-control')??'',/\bno-store\b/);
        const html=await notice.text();
        assert.match(html,/Portable Harbor trial/);
        assert.match(html,expected);
        assert.match(html,/Business onboarding is pending/);
        assert.match(html,/Fictional Portable &amp; Co/);
        assert.deepEqual([...html.matchAll(/href="mailto:([^"]+)"/g)].map(match=>match[1]),['privacy+portable@example.test']);
        assert.doesNotMatch(html,/Cloudflare|Optional Gmail|Optional Calendar|email sequences|forged-notice-user/);
      }
      const health=await request('/healthz');
      assert.equal(health.status,fixture?503:200);
      assert.equal(await health.text(),fixture?'unavailable':'ready');
      const anonymous=await request('/',{headers:{'oai-authenticated-user-id':'forged-user'}});
      assert.match(anonymous.headers.get('location'),/\/auth\/sign-in/);
      const keys=await generateKeyPair('RS256');
      const jwk={...await exportJWK(keys.publicKey),kid:'portable-fixture',alg:'RS256'};
      async function prepareSignIn(email,send=request,loginOrigin=origin,returnTo='/'){
        const response=await send('/auth/google/start?'+new URLSearchParams({return_to:returnTo}));
        assert.equal(response.status,303);
        const authorization=new URL(response.headers.get('location'));
        if(loginOrigin.startsWith('https:'))assert.match(response.headers.getSetCookie()[0],/^__Host-harbor-attempt=.*; Secure$/);
        assert.equal(authorization.origin,'https://accounts.google.com');
        assert.equal(authorization.searchParams.get('scope'),'openid email profile');
        const token=await new SignJWT({sub:'portable-'+email,email,email_verified:true,
          name:'Harbor Fixture',nonce:authorization.searchParams.get('nonce')})
          .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer('https://accounts.google.com')
          .setAudience(env.HARBOR_LOGIN_GOOGLE_CLIENT_ID).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
        await writeFile(env.HARBOR_GOOGLE_FIXTURE,JSON.stringify({token,jwk,challenge:authorization.searchParams.get('code_challenge')}));
        const state=authorization.searchParams.get('state');
        const path='/auth/google/callback?'+new URLSearchParams({code:'fixture-code',state});
        return {path,state,headers:{cookie:response.headers.getSetCookie()[0].split(';')[0]}};
      }
      async function signIn(email,send=request,loginOrigin=origin,returnTo='/'){
        const attempt=await prepareSignIn(email,send,loginOrigin,returnTo);
        const callback=await send(attempt.path,{headers:attempt.headers});
        assert.equal(callback.status,303);
        assert.equal(callback.headers.get('location'),new URL(returnTo,loginOrigin).href,logs);
        const session=callback.headers.getSetCookie().find(value=>/^(?:__Host-)?harbor-session=/.test(value));
        if(loginOrigin.startsWith('https:'))assert.match(session,/; Secure$/);
        return {cookie:session.split(';')[0]};
      }
      const retryDestination='/?invitation=11111111-2222-4333-8444-555555555555';
      const cancelled=await prepareSignIn('owner@example.test',request,origin,retryDestination);
      const retry=await request('/auth/google/callback?'+new URLSearchParams({state:cancelled.state,error:'access_denied'}),{headers:cancelled.headers});
      assert.equal(retry.status,303);
      const retryPage=new URL(retry.headers.get('location'));
      assert.equal(retryPage.searchParams.get('return_to'),retryDestination);
      const reference=retryPage.searchParams.get('reference');
      assert.match(reference,/^[0-9a-f-]{36}$/);
      assert.match(logs,new RegExp('"event":"harbor_portable_sign_in_failed","reference":"'+reference+'","stage":"attempt"'));
      assert.ok(!logs.includes(cancelled.state));
      assert.equal(retry.headers.getSetCookie().length,1);
      const retryHtml=await(await request(retryPage.pathname+retryPage.search)).text();
      assert.ok(retryHtml.includes('<code>'+reference+'</code>'));
      const forged=await (await request('/auth/sign-in?error=sign_in_failed&reference=private-provider-message')).text();
      assert.doesNotMatch(forged.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''),/private-provider-message|share this reference/);
      assert.ok(retryHtml.includes('href="/auth/google/start?return_to='+encodeURIComponent(retryDestination)+'"'));
      const headers=await signIn('owner@example.test');
      const other=await signIn('other@example.test');
      if(process.env.HARBOR_TEST_RAILWAY_ROLLBACK_COMMAND){
        await verifyPortableRailwayRollback({env,directory,mock,signIn,command:process.env.HARBOR_TEST_RAILWAY_ROLLBACK_COMMAND});
        t.diagnostic('Earlier Railway app reopened the pre-upgrade Contact and private attachment after restore.');
        return;
      }
      if(process.env.HARBOR_TEST_RECOVERY_ONLY==='true'){
        assert.ok(fixture,'The focused recovery rehearsal requires disposable private storage.');
        const timing=await verifyPortableRecoveryJourney({env,mock,request,headers,sql,directory,signIn,fixture});
        t.diagnostic('Focused recovery journey verified the captured data and excluded later Contact and attachment edits.');
        t.diagnostic(JSON.stringify(timing));
        return;
      }
      const signedIn=await request('/',{headers});
      assert.equal(signedIn.status,200);
      const home=await signedIn.text();
      assert.match(home,/owner@example\.test/);
      const guidePath='/?view=getting-started';
      const workspacesPath='/?view=workspaces';
      assert.ok(home.includes('href="'+guidePath+'"'));
      assert.ok(home.includes('href="'+workspacesPath+'"'));
      assert.match(home,/<details id="portable-record-import"><summary>Import Contacts CSV<\/summary>/);
      assert.match(home,/<details id="portable-workspace-sharing"><summary>Workspace sharing/);
      const guideAnonymous=await request(guidePath,{headers:{'oai-authenticated-user-id':'forged-guide-user'}});
      assert.equal(guideAnonymous.status,307);
      const guideSignIn=new URL(guideAnonymous.headers.get('location'),origin);
      assert.equal(guideSignIn.pathname,'/auth/sign-in');
      assert.equal(guideSignIn.searchParams.get('return_to'),guidePath);
      assert.equal((await request(guidePath+'&workspaceId='+randomUUID(),{headers})).status,404);
      const [beforeGuide]=await sql`SELECT (SELECT count(*)::int FROM private_workspaces) AS workspaces,
        (SELECT count(*)::int FROM contacts) AS contacts, (SELECT count(*)::int FROM portable_jobs) AS jobs`;
      const workspaceAnonymous=await request(workspacesPath);
      assert.equal(workspaceAnonymous.status,307);
      assert.equal(new URL(workspaceAnonymous.headers.get('location'),origin).searchParams.get('return_to'),workspacesPath);
      assert.equal((await request(workspacesPath+'&workspaceId='+randomUUID(),{headers})).status,404);
      const workspacePage=await request(workspacesPath,{headers});
      assert.equal(workspacePage.status,200);
      assert.match(await workspacePage.text(),/<h1>Workspaces<\/h1>[\s\S]*<details id="portable-workspace-sharing" open="">/);
      const guide=await request(guidePath,{headers});
      assert.equal(guide.status,200);
      const guideHtml=await guide.text();
      assert.ok(guideHtml.includes('href="/?view=workspaces#invite-teammate"'));
      assert.match(guideHtml,/<nav[^>]*aria-label="CRM records"/);
      assert.match(guideHtml,/<h1[^>]*>Get started with Harbor<\/h1>/);
      assert.match(guideHtml,/<details id="portable-paired-import"><summary>Import Contacts and Companies CSV<\/summary>/);
      assert.match(guideHtml,/<details id="portable-record-import"><summary>Import Contacts CSV<\/summary>/);
      assert.match(guideHtml,/<a href="\/">Open Contacts<\/a>/);
      assert.match(guideHtml,/<strong>Logged activities<\/strong>[\s\S]*<strong>Contact files<\/strong>/);
      assert.match(guideHtml,/<strong>Scheduled notes<\/strong>[\s\S]*<strong>Schedule note<\/strong>/);
      assert.match(guideHtml,/<strong>View job<\/strong>[\s\S]*check when the worker last reported/);
      for(const link of ['/?kind=deals&amp;view=board','/?kind=tasks',
        workspacesPath,'/?view=job-queue','/privacy','/terms','/harbor-starter-contacts.csv','/harbor-starter-contacts-and-companies.csv']){
        assert.ok(guideHtml.includes('href="'+link+'"'),link);
      }
      const starter=await request('/harbor-starter-contacts.csv');
      assert.equal(starter.status,200);
      assert.match(starter.headers.get('content-type'),/^text\/csv/);
      const csv=await starter.text();
      const review=await request('/api/crm/import',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
        body:JSON.stringify({action:'preview',kind:'contacts',csv})});
      assert.equal(review.status,200);
      const preview=await review.json();
      assert.deepEqual([preview.created,preview.skipped,preview.errors],[3,0,0]);
      assert.ok(preview.rows.every(row=>row.email.endsWith('@example.test')));
      const pairedStarter=await request('/harbor-starter-contacts-and-companies.csv');
      assert.equal(pairedStarter.status,200);
      assert.match(pairedStarter.headers.get('content-type'),/^text\/csv/);
      const pairedCsv=await pairedStarter.text();
      const importRequest=(action,options={})=>request('/api/crm/import',{method:'POST',
        headers:{...headers,origin,'content-type':'application/json'},
        body:JSON.stringify({action,kind:'paired',csv:pairedCsv,...options})});
      const mappingResponse=await importRequest('columns');
      assert.equal(mappingResponse.status,200);
      const {columns}=await mappingResponse.json();
      const mapping=columns.map(column=>column.target);
      assert.deepEqual(mapping,['contacts/name','contacts/email','companies/name','companies/domain']);
      const pairedResponse=await importRequest('preview',{mapping});
      assert.equal(pairedResponse.status,200);
      const pairedPreview=await pairedResponse.json();
      assert.deepEqual(pairedPreview.paired,{contacts:3,companies:2,reusedCompanies:0});
      assert.equal(pairedPreview.errors,0);
      assert.deepEqual(pairedPreview.rows.filter(row=>row.object==='Contact').map(row=>row.company),
        ['Juniper Studio','Northline Supply','Juniper Studio']);
      const [afterGuide]=await sql`SELECT (SELECT count(*)::int FROM private_workspaces) AS workspaces,
        (SELECT count(*)::int FROM contacts) AS contacts, (SELECT count(*)::int FROM portable_jobs) AS jobs`;
      assert.deepEqual(afterGuide,beforeGuide);
      // An owner can onboard a teammate before importing any CRM records.
      const sharingChange=body=>request('/api/workspaces',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
        body:JSON.stringify(body)});
      assert.equal((await (await request('/api/workspaces',{headers})).json()).owned,null);
      const invitations=await Promise.all([0,1].map(()=>sharingChange({action:'invite',email:'other@example.test'})));
      assert.deepEqual(invitations.map(response=>response.status),[200,200]);
      const [firstInvite,replayedInvite]=await Promise.all(invitations.map(response=>response.json()));
      assert.ok(firstInvite.owned);
      assert.equal(firstInvite.sent.length,1);
      assert.equal(replayedInvite.owned,firstInvite.owned);
      assert.deepEqual(replayedInvite.sent,firstInvite.sent);
      assert.equal((await sharingChange({action:'cancel_invite',id:firstInvite.sent[0].id})).status,200);
      assert.equal((await sql`SELECT count(*)::int AS count FROM contacts WHERE workspace_id=${firstInvite.owned}`)[0].count,0);
      // The guide preview and later file writes are independent fixture scenarios.
      await sql`DELETE FROM portable_request_budgets WHERE scope='api_write'
        AND subject=(SELECT id FROM login_identities WHERE email='owner@example.test')`;
      for(const path of ['/?kind=deals&view=board','/?kind=tasks','/?view=job-queue']){
        assert.equal((await request(path,{headers})).status,200,path);
      }
      const contacts=(auth,query='')=>request('/api/crm'+query,{headers:auth});
      const save=(auth,data,site=origin)=>request('/api/crm',{method:'POST',
        headers:{...auth,origin:site,'content-type':'application/json'},
        body:JSON.stringify({action:'save',kind:'contacts',...data}),
      });
      const company=(auth,query='')=>contacts(auth,'?kind=companies'+query);
      const saveCompany=(auth,data,site=origin)=>save(auth,{kind:'companies',...data},site);
      assert.equal((await request('/?kind=companies')).status,307);
      assert.equal((await company({})).status,401);
      assert.equal((await saveCompany(headers,{data:{name:'Blocked company'}},'https://outside.example.test')).status,403);
      assert.equal((await saveCompany(headers,{data:{name:'Unsafe company',website:'javascript:alert(1)'}})).status,400);
      assert.equal((await saveCompany(headers,{data:{name:'Invalid tenant',workspaceId:'foreign'}})).status,400);
      const companyResponse=await saveCompany(headers,{data:{name:'Owner Company',domain:'owner.example.test',website:'https://owner.example.test',industry:'Testing',city:'Boston',numberOfEmployees:0,targetAccount:false}});
      const otherCompanyResponse=await saveCompany(other,{data:{name:'Other Company'}});
      assert.deepEqual([companyResponse.status,otherCompanyResponse.status],[201,201]);
      const {record:companyRecord}=await companyResponse.json(),{record:otherCompany}=await otherCompanyResponse.json();
      const foreignCompany=await company(other,'&id='+companyRecord.id);
      assert.equal(foreignCompany.status,404);
      assert.equal(foreignCompany.headers.get('x-harbor-error-reference'),null);
      assert.equal((await contacts(headers,'?id='+companyRecord.id)).status,404);
      assert.equal((await saveCompany(other,{id:companyRecord.id,expectedRevision:1,data:{name:'Foreign edit'}})).status,404);
      const companyEdits=await Promise.all(['Cambridge','Somerville'].map(city=>saveCompany(headers,{
        id:companyRecord.id,expectedRevision:1,data:{...companyRecord.data,city,numberOfEmployees:undefined,targetAccount:undefined},
      })));
      assert.deepEqual(companyEdits.map(result=>result.status).sort(),[200,409]);
      const {record:updatedCompany}=await companyEdits.find(result=>result.ok).json();
      assert.equal(updatedCompany.revision,2);
      assert.equal(updatedCompany.data.numberOfEmployees,0);
      assert.equal(updatedCompany.data.targetAccount,false);
      const companyEvents=await sql`SELECT revision,previous,data FROM company_events WHERE company_id=${companyRecord.id} ORDER BY revision`;
      assert.deepEqual(companyEvents.map(event=>[event.revision,event.previous?.city,event.data.city]),[
        [1,undefined,'Boston'],[2,'Boston',updatedCompany.data.city],
      ]);
      const propertyHistory=(auth,field,extra='')=>request('/api/crm?'+new URLSearchParams({
        kind:'companies',history:companyRecord.id,field,
      })+extra,{headers:auth});
      assert.equal((await propertyHistory({},'city')).status,401);
      assert.equal((await propertyHistory(other,'city')).status,404);
      assert.equal((await propertyHistory(headers,'actorId')).status,400);
      assert.equal((await propertyHistory(headers,'city','&field=domain')).status,400);
      const cityHistory=await propertyHistory(headers,'city');
      assert.equal(cityHistory.status,200);
      const historyPage=await cityHistory.json();
      assert.deepEqual(historyPage.items.map(item=>[item.revision,item.previous,item.value]),[
        [2,'Boston',updatedCompany.data.city],[1,null,'Boston'],
      ]);
      assert.ok(historyPage.items.every(item=>item.actorName&&Number.isFinite(Date.parse(item.occurredAt))));
      assert.equal(historyPage.next,null);
      assert.deepEqual((await (await propertyHistory(headers,'city','&before=2')).json()).items,[historyPage.items[1]]);
      for(const [field,value] of [['numberOfEmployees',0],['targetAccount',false]]){
        const page=await (await propertyHistory(headers,field)).json();
        assert.deepEqual(page.items.map(item=>[item.revision,item.value]),[[1,value]]);
      }
      await sql`ALTER TABLE company_events ADD CONSTRAINT fixture_reject_revision CHECK (revision < 3)`;
      try{
        const privateName='Uncommitted company edit';
        const failed=await saveCompany(headers,{id:companyRecord.id,expectedRevision:2,data:{name:privateName}});
        assert.equal(failed.status,500);
        assert.match(failed.headers.get('cache-control'),/no-store/);
        const reference=failed.headers.get('x-harbor-error-reference');
        assert.match(reference,/^[0-9a-f-]{36}$/);
        const entry=logs.split('\n').find(line=>line.includes(reference));
        assert.ok(entry);
        assert.deepEqual(JSON.parse(entry),{event:'harbor_portable_api_failed',reference,route:'/api/crm',status:500});
        assert.ok(!entry.includes(privateName)&&!entry.includes(companyRecord.id));
        assert.deepEqual(await (await company(headers,'&id='+companyRecord.id)).json(),updatedCompany);
      }finally{await sql`ALTER TABLE company_events DROP CONSTRAINT fixture_reject_revision`;}
      const anotherCompany=await saveCompany(headers,{data:{name:'Owner Second Company',numberOfEmployees:12,targetAccount:true}});
      assert.equal(anotherCompany.status,201);
      const companyPage=await (await company(headers,'&limit=1')).json();
      const companyNext=await (await company(headers,'&limit=1&after='+companyPage.next)).json();
      const {record:secondCompany}=await anotherCompany.json();
      assert.deepEqual([companyPage.records.length,companyNext.records.length,companyNext.next],[1,1,null]);
      assert.deepEqual(new Set([companyPage.records[0].id,companyNext.records[0].id]),
        new Set([companyRecord.id,secondCompany.id]));
      assert.deepEqual((await (await company(other)).json()).records.map(row=>row.id),[otherCompany.id]);
      assert.deepEqual((await (await company(headers,'&search=OWNER.EXAMPLE')).json()).records.map(row=>row.id),[companyRecord.id]);
      assert.deepEqual((await (await company(headers,'&search=Other')).json()).records,[]);
      assert.deepEqual((await (await company(headers,'&search=%25')).json()).records,[]);
      const clearedCompany=await saveCompany(headers,{id:secondCompany.id,expectedRevision:1,
        data:{...secondCompany.data,numberOfEmployees:null,targetAccount:null}});
      assert.equal(clearedCompany.status,200);
      const {record:clearedCompanyRecord}=await clearedCompany.json();
      assert.equal(Object.hasOwn(clearedCompanyRecord.data,'numberOfEmployees'),false);
      assert.equal(Object.hasOwn(clearedCompanyRecord.data,'targetAccount'),false);
      const companyHtml=await (await request('/?kind=companies',{headers})).text();
      assert.match(companyHtml,/Owner Company/);
      assert.match(companyHtml,/Add company/);
      assert.doesNotMatch(companyHtml,/Other Company/);
      const companySearch=(await (await request('/?kind=companies&search=OWNER.EXAMPLE',{headers})).text());
      assert.match(companySearch,/name="search"/);
      assert.match(companySearch,/Owner Company/);
      assert.doesNotMatch(companySearch,/Other Company|Owner Second Company/);
      const deal=(auth,query='')=>contacts(auth,'?kind=deals'+query);
      const saveDeal=(auth,data)=>save(auth,{kind:'deals',...data});
      assert.equal((await request('/?kind=deals')).status,307);
      assert.equal((await deal({})).status,401);
      assert.equal((await deal(headers,'&stage=foreign')).status,400);
      for(const invalid of [{amount:-1},{closeDate:'2026-02-30'},{pipelineId:'custom'},{forecastCategory:'Invalid category'}]){
        assert.equal((await saveDeal(headers,{data:{name:'Invalid deal',...invalid}})).status,400);
      }
      const createDeal=await saveDeal(headers,{companyId:companyRecord.id,data:{name:'Owner Deal',amount:1250.50,closeDate:'2026-12-12',nextStep:'Review the proposal',forecastCategory:'Best case'}});
      const createOtherDeal=await saveDeal(other,{data:{name:'Other Deal',stage:'Closed won'}});
      assert.deepEqual([createDeal.status,createOtherDeal.status],[201,201]);
      const {record:dealRecord}=await createDeal.json(),{record:otherDeal}=await createOtherDeal.json();
      assert.equal(dealRecord.data.stage,'Appointment scheduled');
      assert.equal((await deal(other,'&id='+dealRecord.id)).status,404);
      assert.equal((await saveDeal(other,{id:dealRecord.id,expectedRevision:1,data:dealRecord.data})).status,404);
      const dealEdits=await Promise.all([1500,1750].map(amount=>saveDeal(headers,{
        id:dealRecord.id,expectedRevision:1,data:{...dealRecord.data,amount,stage:'Closed won',nextStep:undefined},
      })));
      assert.deepEqual(dealEdits.map(result=>result.status).sort(),[200,409]);
      let {record:updatedDeal}=await dealEdits.find(result=>result.ok).json();
      assert.equal(updatedDeal.revision,2);
      assert.equal(updatedDeal.data.nextStep,'Review the proposal');
      assert.equal(updatedDeal.data.forecastCategory,'Best case');
      assert.equal(updatedDeal.companyId,companyRecord.id);
      assert.equal(updatedDeal.companyName,updatedCompany.data.name);
      assert.equal(updatedDeal.primaryContactId,null);
      const dealHistory=await sql`SELECT revision,previous,data FROM deal_events WHERE deal_id=${dealRecord.id} ORDER BY revision`;
      assert.deepEqual(dealHistory.map(event=>[event.revision,event.previous?.stage,event.data.stage]),[
        [1,undefined,'Appointment scheduled'],[2,'Appointment scheduled','Closed won'],
      ]);
      await sql`ALTER TABLE deal_events ADD CONSTRAINT fixture_reject_revision CHECK (revision < 3)`;
      try{
        assert.equal((await saveDeal(headers,{id:dealRecord.id,expectedRevision:2,companyId:null,data:{...dealRecord.data,stage:'Closed lost'}})).status,500);
        assert.deepEqual(await (await deal(headers,'&id='+dealRecord.id)).json(),updatedDeal);
      }finally{await sql`ALTER TABLE deal_events DROP CONSTRAINT fixture_reject_revision`;}
      const secondDealResponse=await saveDeal(headers,{data:{name:'Owner Second Deal',stage:'Closed won'}});
      assert.equal(secondDealResponse.status,201);
      const {record:secondDeal}=await secondDealResponse.json();
      const filtered='&stage=Closed%20won&limit=1';
      const dealPage=await (await deal(headers,filtered)).json();
      const dealNext=await (await deal(headers,filtered+'&after='+dealPage.next)).json();
      assert.deepEqual([dealPage.records.length,dealNext.records.length,dealNext.next],[1,1,null]);
      assert.deepEqual(new Set([dealPage.records[0].id,dealNext.records[0].id]),new Set([dealRecord.id,secondDeal.id]));
      assert.deepEqual((await (await deal(headers,'&stage=Appointment%20scheduled')).json()).records,[]);
      assert.deepEqual((await (await deal(other,'&stage=Closed%20won')).json()).records.map(row=>row.id),[otherDeal.id]);
      const dealHtml=await (await request('/?kind=deals&stage=Closed%20won',{headers})).text();
      assert.match(dealHtml,/Owner Deal/);
      assert.match(dealHtml,/Add deal/);
      assert.doesNotMatch(dealHtml,/Other Deal/);
      assert.equal((await contacts({'oai-authenticated-user-id':'forged-user'})).status,401);
      assert.equal((await save(headers,{data:{name:'Blocked contact'}},'https://outside.example.test')).status,403);
      assert.equal((await save(headers,{data:{name:'X'.repeat(17000)}})).status,400);
      assert.equal((await save(headers,{data:{name:'Blocked foreign link'},primaryCompanyId:otherCompany.id})).status,404);
      const [first,second,third]=await Promise.all([
        save(headers,{data:{name:'Owner only',email:'owner-contact@example.test',postalCode:'00501',leadStatus:'Connected'},primaryCompanyId:companyRecord.id}),
        save(headers,{data:{name:'Owner second'}}),
        save(other,{data:{name:'Other only'}}),
      ]);
      assert.deepEqual([first.status,second.status,third.status],[201,201,201]);
      const {record}=await first.json(),{record:secondRecord}=await second.json(),{record:otherRecord}=await third.json();
      await stop();
      const originalMode=env.HARBOR_PORTABLE_MODE;
      Object.assign(env,personalGoogle,{HARBOR_PORTABLE_MODE:'local'});
      const calendarSecret=env.HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_SECRET;
      delete env.HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_SECRET;
      await start();
      const setupGuide=await request('/?view=getting-started',{headers});
      assert.equal(setupGuide.status,200);
      const setupHtml=await setupGuide.text();
      assert.match(setupHtml,/<a href="\/\?view=email-settings">Open Email settings<\/a>/);
      assert.match(setupHtml,/OAuth client ID or secret is not set/);
      assert.doesNotMatch(setupHtml,/<a href="\/\?view=calendar">Open Calendar<\/a>/);
      await stop();
      env.HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_SECRET=calendarSecret;
      await start();
      await sql`ALTER TABLE public.portable_google_grants RENAME TO portable_google_grants_lookup_fixture`;
      try{
        const unavailableStatus=/Saved connection status is temporarily unavailable\./;
        const contactHome=await request('/',{headers});
        assert.equal(contactHome.status,200);
        assert.match(await contactHome.text(),/Owner only/);
        const unavailableGuide=await request(guidePath,{headers});
        assert.equal(unavailableGuide.status,200);
        const unavailableGuideHtml=await unavailableGuide.text();
        assert.match(unavailableGuideHtml,unavailableStatus);
        assert.match(unavailableGuideHtml,/<details id="portable-paired-import"><summary>Import Contacts and Companies CSV<\/summary>/);
        assert.match(unavailableGuideHtml,/<a href="\/\?view=workspaces#invite-teammate">Invite a teammate<\/a>/);
        for(const view of ['email-settings','calendar']){
          const panelPage=await request('/?view='+view,{headers});
          assert.equal(panelPage.status,200);
          const panelHtml=(await panelPage.text()).replaceAll('<!-- -->','');
          assert.match(panelHtml,unavailableStatus);
          assert.match(panelHtml,/<button[^>]*>Refresh connection status<\/button>/);
          assert.doesNotMatch(panelHtml,/<form[^>]*action="\/api\/google\/connections/);
          assert.doesNotMatch(panelHtml,/<button[^>]*>(?:Connect (?:Gmail|Google Calendar)|Check (?:Gmail|Google Calendar) connection|Disconnect(?: (?:Gmail|Google Calendar))?)<\/button>/);
        }
      }finally{await sql`ALTER TABLE public.portable_google_grants_lookup_fixture RENAME TO portable_google_grants`;}
      const personalContact=async auth=>{
        const created=await save(auth,{data:{name:'Personal integration fixture',email:'personal-sender@example.test'}});
        assert.equal(created.status,201,await created.clone().text());
        return (await created.json()).record.id;
      };
      const personalOwnerContact=await personalContact(headers),personalOtherContact=await personalContact(other);
      const logStart=logs.length;
      await verifyPersonalGoogle({request,origin,headers,other,signIn,sql,fixture:personalGoogle,
        ownerContact:personalOwnerContact,otherContact:personalOtherContact});
      const event='harbor_portable_google_connection_check';
      const connectionChecks=logs.slice(logStart).split('\n').filter(line=>line.includes('"event":"'+event+'"'))
        .map(line=>JSON.parse(line));
      assert.deepEqual(connectionChecks,[
        {event,provider:'gmail',status:503},
        {event,provider:'gmail',status:409},
        {event,provider:'gmail',status:200},
        {event,provider:'calendar',status:409},
        {event,provider:'calendar',status:503},
        {event,provider:'calendar',status:200},
      ]);
      await sql.begin(async tx=>{
        await tx`DELETE FROM portable_gmail_log_receipts WHERE contact_id=${personalOwnerContact}`;
        await tx`DELETE FROM portable_contact_activities WHERE contact_id=${personalOwnerContact}`;
        await tx`DELETE FROM contact_events WHERE contact_id IN (${personalOwnerContact},${personalOtherContact})`;
        await tx`DELETE FROM contacts WHERE id IN (${personalOwnerContact},${personalOtherContact})`;
      });
      await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
        AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
      t.diagnostic('Two account-bound personal Google connections used separate Gmail inboxes and Calendar windows.');
      await stop();
      for(const key of Object.keys(personalGoogle))delete env[key];
      const microsoft=outlookFixture(directory);
      Object.assign(env,microsoft);
      await start();
      await verifyOutlookConnections({request,origin,headers,other,sql,fixture:microsoft,verifyRecords:verifyOutlookRecords});
      await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
        AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
      t.diagnostic('Personal Outlook Mail and Calendar matched separate accounts, checked availability and selectively logged activities.');
      await stop();
      for(const key of Object.keys(microsoft))delete env[key];
      if(originalMode===undefined)delete env.HARBOR_PORTABLE_MODE;else env.HARBOR_PORTABLE_MODE=originalMode;
      await start();
      assert.equal(record.primaryCompanyName,'Owner Company');
      await assert.rejects(sql`UPDATE contacts SET primary_company_id=${otherCompany.id} WHERE id=${record.id}`,
        error=>error.code==='23503');
      assert.equal((await contacts(other,'?id='+record.id)).status,404);
      assert.equal((await contacts(headers,'?id='+otherRecord.id)).status,404);
      assert.equal((await save(other,{id:record.id,expectedRevision:1,data:{name:'Cross-tenant edit'}})).status,404);
      const edits=await Promise.all([
        save(headers,{id:record.id,expectedRevision:1,data:{name:'Owner edit A'}}),
        save(headers,{id:record.id,expectedRevision:1,data:{name:'Owner edit B'}}),
      ]);
      assert.deepEqual(edits.map(result=>result.status).sort(),[200,409]);
      const {record:updated}=await edits.find(result=>result.ok).json();
      assert.equal(updated.revision,2);
      assert.equal(updated.primaryCompanyId,companyRecord.id);
      assert.equal(updated.data.postalCode,'00501');
      assert.equal(updated.data.leadStatus,'Connected');
      const [counts]=await sql`SELECT count(*)::int AS total, count(DISTINCT workspace_id)::int AS workspaces FROM contact_events`;
      assert.deepEqual({...counts},{total:4,workspaces:2});
      const history=await sql`SELECT revision, previous, data FROM contact_events WHERE contact_id=${record.id} ORDER BY revision`;
      assert.deepEqual(history.map(event=>[event.revision,event.previous?.name,event.data.name]),[
        [1,undefined,'Owner only'],[2,'Owner only',updated.data.name],
      ]);
      // Inject a receipt-write failure and check that the contact update rolls back with it.
      await sql`ALTER TABLE contact_events ADD CONSTRAINT fixture_reject_revision CHECK (revision < 3)`;
      try {
        const rejected=await save(headers,{id:record.id,expectedRevision:2,data:{name:'Uncommitted edit'},primaryCompanyId:null});
        assert.equal(rejected.status,500);
        const persisted=await (await contacts(headers,'?id='+record.id)).json();
        assert.deepEqual([persisted.revision,persisted.data.name],[2,updated.data.name]);
        assert.equal(persisted.primaryCompanyId,companyRecord.id);
      } finally {
        await sql`ALTER TABLE contact_events DROP CONSTRAINT fixture_reject_revision`;
      }
      const page=await (await contacts(headers,'?limit=1')).json();
      const more=await (await contacts(headers,'?limit=1&after='+page.next)).json();
      assert.deepEqual([page.records.length,more.records.length,more.next],[1,1,null]);
      assert.deepEqual(new Set([page.records[0].id,more.records[0].id]),new Set([record.id,secondRecord.id]));
      const linkSecond=async(expectedRevision,primaryCompanyId)=>save(headers,{
        id:secondRecord.id,expectedRevision,data:secondRecord.data,primaryCompanyId,
      });
      assert.equal((await linkSecond(1,secondCompany.id)).status,200);
      assert.equal((await linkSecond(1,null)).status,409);
      assert.equal((await linkSecond(2,otherCompany.id)).status,404);
      const cleared=await linkSecond(2,null);
      assert.equal(cleared.status,200);
      assert.equal((await cleared.json()).record.primaryCompanyId,null);
      const companyHistory=await sql`SELECT previous_primary_company_id,primary_company_id FROM contact_events
        WHERE contact_id=${secondRecord.id} ORDER BY revision`;
      assert.deepEqual(companyHistory.map(row=>[row.previous_primary_company_id,row.primary_company_id]),
        [[null,null],[null,secondCompany.id],[secondCompany.id,null]]);
      assert.deepEqual((await (await contacts(other)).json()).records.map(row=>row.id),[otherRecord.id]);
      assert.equal((await contacts(headers,'?limit=51')).status,400);
      assert.deepEqual((await (await contacts(headers,'?search=OWNER%20EDIT')).json()).records.map(row=>row.id),[record.id]);
      assert.deepEqual((await (await contacts(headers,'?search=%25')).json()).records,[]);
      assert.deepEqual((await (await contacts(headers,'?search=Other')).json()).records,[]);
      const linkDeal=async(expectedRevision,links)=>saveDeal(headers,{
        id:dealRecord.id,expectedRevision,data:updatedDeal.data,...links,
      });
      assert.equal((await linkDeal(2,{primaryContactId:otherRecord.id})).status,404);
      assert.equal((await linkDeal(2,{companyId:otherCompany.id})).status,404);
      await assert.rejects(sql`UPDATE deals SET company_id=${otherCompany.id} WHERE id=${dealRecord.id}`,error=>error.code==='23503');
      await assert.rejects(sql`UPDATE deals SET primary_contact_id=${otherRecord.id} WHERE id=${dealRecord.id}`,error=>error.code==='23503');
      const linkedDeal=await linkDeal(2,{primaryContactId:record.id});
      assert.equal(linkedDeal.status,200);
      ({record:updatedDeal}=await linkedDeal.json());
      assert.deepEqual([updatedDeal.companyId,updatedDeal.primaryContactId,updatedDeal.primaryContactName],
        [companyRecord.id,record.id,updated.data.name]);
      assert.equal((await linkDeal(2,{primaryContactId:null})).status,409);
      const clearable=await saveDeal(headers,{id:secondDeal.id,expectedRevision:1,data:secondDeal.data,
        companyId:secondCompany.id,primaryContactId:secondRecord.id});
      assert.equal(clearable.status,200);
      const unlinked=await saveDeal(headers,{id:secondDeal.id,expectedRevision:2,data:secondDeal.data,
        companyId:null,primaryContactId:null});
      assert.equal(unlinked.status,200);
      const {record:unlinkedDeal}=await unlinked.json();
      assert.deepEqual([unlinkedDeal.companyId,unlinkedDeal.primaryContactId],[null,null]);
      const links=await sql`SELECT previous_company_id,company_id,previous_primary_contact_id,primary_contact_id
        FROM deal_events WHERE deal_id=${secondDeal.id} ORDER BY revision`;
      assert.deepEqual(links.map(row=>Object.values(row)),[
        [null,null,null,null],[null,secondCompany.id,null,secondRecord.id],[secondCompany.id,null,secondRecord.id,null],
      ]);

      const linkedContacts='?companyId='+companyRecord.id;
      assert.deepEqual((await (await contacts(headers,linkedContacts)).json()).records.map(row=>row.id),[record.id]);
      assert.deepEqual((await (await contacts(other,linkedContacts)).json()).records,[]);
      const linkedSearch=await (await request('/'+linkedContacts+'&search=Owner+edit',{headers})).text();
      assert.match(linkedSearch,/Owner edit [AB]/);
      assert.match(linkedSearch,new RegExp('name="companyId" value="'+companyRecord.id+'"'));
      assert.match(linkedSearch,new RegExp('href="/\\?companyId='+companyRecord.id+'">Clear filters</a>'));
      assert.doesNotMatch(linkedSearch,/Owner second|Other only/);
      assert.equal((await request('/'+linkedContacts,{headers:other})).status,404);
      assert.equal((await company(headers,'&companyId='+companyRecord.id)).status,400);
      assert.equal((await deal(headers,'&id='+dealRecord.id+'&primaryContactId='+record.id)).status,400);
      const detailHtml=await (await request('/?kind=deals&record='+dealRecord.id,{headers})).text();
      assert.match(detailHtml,/<summary>More properties<\/summary>/);
      assert.match(detailHtml,/<dt>Next step<\/dt><dd>Review the proposal<\/dd>/);
      assert.match(detailHtml,/<button[^>]*>Edit all properties<\/button>/);
      assert.match(detailHtml,new RegExp('href="/\\?contact='+record.id+'"'));
      assert.match(detailHtml,new RegExp('href="/\\?record='+companyRecord.id+'&amp;kind=companies"'));

      const ownHtml=await (await request('/',{headers})).text();
      assert.match(ownHtml,/Owner edit [AB]/);
      assert.match(ownHtml,/Primary company/);
      assert.doesNotMatch(ownHtml,/Other only/);
      const otherHtml=await (await request('/',{headers:other})).text();
      assert.match(otherHtml,/Other only/);
      assert.doesNotMatch(otherHtml,/Owner edit [AB]/);
      const signOut=await request('/auth/sign-out',{headers});
      assert.equal(signOut.status,200);
      assert.match(await signOut.text(),/Sign out of this browser/);
      for(const path of ['/api/v1/files/fictional/download','/workspaces','/background-jobs']){
        assert.equal((await request(path,{headers})).status,404);
      }
      let verifyFilesAfterRestart;
      if(fixture){
        verifyFilesAfterRestart=await verifyPortableFiles({fixture,request,origin,headers,other,record,otherRecord,sql});
        t.diagnostic('Private file checks ran against a local S3-compatible endpoint.');
      }else t.diagnostic('Set HARBOR_TEST_S3_ENDPOINT for the optional local S3-compatible file checks.');
      const ledgerPath='/api/crm?id='+record.id;
      const awaitStatus=async(path,expected)=>{
        let response;
        for(let attempt=0;attempt<25;attempt++){
          response=await request(path,{headers});
          if(response.status===expected)return response;
          await delay(100);
        }
        assert.equal(response?.status,expected);
      };
      assert.equal((await request(ledgerPath,{headers})).status,200);
      const [oldReceipt]=await sql`SELECT id,hash FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 1`;
      await sql`UPDATE drizzle.__drizzle_migrations SET hash='fixture-mismatch' WHERE id=${oldReceipt.id}`;
      try{
        const denied=await awaitStatus(ledgerPath,503);
        assert.equal(denied.headers.get('retry-after'),'1');
        assert.equal(denied.headers.get('cache-control'),'no-store');
        assert.deepEqual(await denied.json(),{error:'Harbor is waiting for a compatible database. Try again shortly.'});
        assert.equal((await request('/healthz')).status,503);
        const head=await request(ledgerPath,{method:'HEAD',headers});
        assert.equal(head.status,503);
        assert.equal(await head.text(),'');
        assert.equal((await request('/auth/google/start')).status,503);
        assert.equal((await request('/auth/sign-in')).status,200);
        assert.equal((await request('/privacy')).status,200);
        assert.equal((await request('/not-a-portable-route')).status,404);
        const name='Blocked during incompatible database history';
        assert.equal((await save(headers,{data:{name}})).status,503);
        assert.equal((await sql`SELECT count(*)::int AS count FROM contacts WHERE data->>'name'=${name}`)[0].count,0);
      }finally{await sql`UPDATE drizzle.__drizzle_migrations SET hash=${oldReceipt.hash} WHERE id=${oldReceipt.id}`;}
      const resumed=await awaitStatus(ledgerPath,200);
      assert.equal((await resumed.json()).id,record.id);
      await stop();
      await start();
      await verifyFilesAfterRestart?.();
      const doctorCalendar=await portableCalendarFixture(await mkdtemp(join(directory,'calendar-doctor-')));
      await verifyPortableDoctor(env,sql,!!fixture,doctorCalendar);
      assert.equal((await request('/healthz')).status,200);

      const companyPagePath='/?kind=companies';
      const pageFaultEvent='harbor_portable_page_failed';
      const pageFaults=from=>logs.slice(from).split('\n').slice(0,-1)
        .filter(line=>line.startsWith('{"event":"'+pageFaultEvent+'"'))
        .map(line=>JSON.parse(line));
      const normalLogStart=logs.length;
      const signedOutCompanyPage=await request(companyPagePath);
      assert.equal(signedOutCompanyPage.status,307);
      assert.equal(new URL(signedOutCompanyPage.headers.get('location'),origin).pathname,'/auth/sign-in');
      await signedOutCompanyPage.text();
      const missingWorkspacePage=await request(companyPagePath+'&workspaceId='+randomUUID(),{headers});
      assert.equal(missingWorkspacePage.status,404);
      await missingWorkspacePage.text();
      assert.deepEqual(pageFaults(normalLogStart),[],'Expected navigation does not report a page failure.');

      const failedLogStart=logs.length;
      await sql`ALTER TABLE public.companies RENAME TO companies_page_fault_fixture`;
      try{
        const privateSearch='private-company-search-fixture';
        const failedPage=await request(companyPagePath+'&search='+privateSearch,{headers});
        assert.ok([200,500].includes(failedPage.status),'A streamed shell may already have sent status 200.');
        const failedHtml=await failedPage.text();
        assert.doesNotMatch(failedHtml,/Failed query:|PostgresError|relation .*companies.* does not exist/i);
        const healthyDuringPageFailure=await request('/healthz');
        assert.equal(healthyDuringPageFailure.status,200);
        assert.equal(await healthyDuringPageFailure.text(),'ready');
        for(let attempt=0;attempt<100&&!pageFaults(failedLogStart).length;attempt++)await delay(20);
        const events=pageFaults(failedLogStart);
        assert.ok(events.length>0,'The operator receives a fault even when the health probe is ready.');
        for(const event of events)assert.deepEqual(event,{event:pageFaultEvent,route:'crm-page'});
      }finally{await sql`ALTER TABLE public.companies_page_fault_fixture RENAME TO companies`;}
      const retryLogStart=logs.length;
      const recoveredCompanyPage=await request(companyPagePath,{headers});
      assert.equal(recoveredCompanyPage.status,200);
      assert.match(await recoveredCompanyPage.text(),/Owner Company/);
      assert.deepEqual(pageFaults(retryLogStart),[],'The restored page renders without another fault.');

      assert.match(await (await request('/',{headers})).text(),/Owner edit [AB]/);
      const restartedContact=await (await contacts(headers,'?id='+record.id)).json();
      assert.equal(restartedContact.revision,2);
      assert.equal(restartedContact.primaryCompanyId,companyRecord.id);
      assert.deepEqual(await (await company(headers,'&id='+companyRecord.id)).json(),updatedCompany);
      assert.deepEqual(await (await deal(headers,'&id='+dealRecord.id)).json(),updatedDeal);
      await verifyPortableCustomProperties({request,origin,headers,other,sql});
      await verifyPortablePropertyGroups({request,origin,headers,other,sql});
      const sharing=await verifyPortableSharing({request,origin,headers,other,record,company:updatedCompany,deal:updatedDeal,sql,fixture});
      await verifyPortableTaskReminders({request,origin,headers,other,sql,sharing});
      await verifyPortableRecordCsv({request,headers,other,sql,workspaceId:sharing.workspaceId,contact:restartedContact,company:updatedCompany,deal:updatedDeal});
      sharing.associations=await verifyPortableAssociations({request,origin,headers,other,contact:restartedContact,company:updatedCompany,
        deal:updatedDeal,foreignContact:otherRecord,workspaceId:sharing.workspaceId,sql});
      sharing.grantId=sharing.associations.grantId;
      await verifyPortableRecordCorrections({request,origin,headers,other,sql,workspaceId:sharing.workspaceId});
      await verifyPortableContactImport({request,origin,headers,other,sql,workspaceId:sharing.workspaceId});
      sharing.verifyProducts=await verifyPortableProducts({request,origin,headers,other,sharing,sql});
      sharing.verifyLineItems=await verifyPortableLineItems({request,origin,headers,other,sharing,sql});
      sharing.verifyQuotes=await verifyPortableQuotes({request,origin,headers,other,contact:restartedContact,company:updatedCompany,sql});
      sharing.verifyInvoices=await verifyPortableInvoices({request,origin,headers,other,sql,company:updatedCompany,workspaceId:sharing.workspaceId});
      await verifyPortableAdditionalImports({request,origin,headers,other,sql,workspaceId:sharing.workspaceId});
      sharing.sharedTicket=await verifyPortableTickets({request,origin,headers,other,sql,workspaceId:sharing.workspaceId,grantId:sharing.grantId,contact:restartedContact,
        company:updatedCompany,foreignContact:otherRecord,foreignCompany:otherCompany});
      sharing.outreach=await verifyPortableContactOutreach({request,origin,headers,other,record,otherRecord,sql,sharing});
      sharing.invitationId=await verifyPortableInvitations({request,origin,headers,other,signIn,sql,workspaceId:sharing.workspaceId});
      await verifyPortableBackupTeamAdministration({request,origin,headers,other,signIn,sql});
      await verifyPortableJobs({request,origin,headers,other,record,otherRecord,sql,env,directory});
      await verifyPortableSharedNotes({request,origin,headers,other,record,otherRecord,sql,env,sharing});
      await verifyPortableSharedOutreach({request,origin,headers,other,record,otherRecord,sql,sharing});
      await verifyPortablePipelines({request,origin,headers,other,sql,sharing});
      sharing.leads=await verifyPortableLeads({request,origin,headers,other,sql,sharing,contact:restartedContact,company:updatedCompany,otherContact:otherRecord});
      await verifyPortableBoard({request,origin,headers,other,sql,sharing});
      await verifyPortableIntake({request,origin,headers,other,sql,sharing,database,
        restartWithDatabase:async url=>{await stop();env.DATABASE_URL=url;await start();}});
      await verifyPortableStageWorkflows({request,origin,headers,other,sql,sharing,record,env});
      await verifyPortableLifecycleWorkflow({request,origin,headers,other,sql,sharing,env});
      await verifyPortableContactCreatedWorkflow({request,origin,headers,other,sql,sharing,env});
      await verifyPortableContactOwnerWorkflow({request,origin,headers,other,sql,sharing,env});
      await verifyPortableCodeDisabled({request,origin,headers});
      await stop();
      env.HARBOR_PORTABLE_CODE_ENABLED='true';
      await start();
      await verifyPortableCodeWorkflow({request,origin,headers,other,foreignContact:otherRecord,sql,env,workspaceId:sharing.workspaceId});
      await stop();
      env.HARBOR_PORTABLE_CODE_ENABLED='false';
      await start();
      sharing.manualWorkflow=await verifyPortableManualWorkflow({request,origin,headers,other,otherRecord,sql,env,sharing});
      sharing.manualNoteBatch=await verifyPortableManualNoteBatch({request,origin,headers,other,foreignContact:otherRecord,sql,env,sharing});
      sharing.taskWorkflow=await verifyPortableTaskWorkflow({request,origin,headers,other,otherRecord,sql,env,sharing});
      await verifyPortableEmailSuppression({request,origin,headers,other,sql,sharing});
      await verifyPortableGmailDisabled({request,origin,headers,record});
      sharing.emailTemplates=await verifyPortableEmailTemplates({request,origin,headers,other,sql,workspaceId:sharing.workspaceId,
        contact:restartedContact,withoutEmail:secondRecord,foreignContact:otherRecord});
      sharing.verifyKnowledge=await verifyPortableKnowledge({request,origin,headers,other,sql,sharing});
      await verifyPortableKnowledgeCategories({request,origin,headers,other,sql,workspaceId:sharing.workspaceId});
      await verifyPortableCalendar({request,origin,headers,other,calendar,enabled:false});
      assert.deepEqual(await (await request('/api/calendar/availability-page',{headers})).json(),
        {enabled:false,revision:null,page:null});
      await stop();
      Object.assign(env,{HARBOR_PORTABLE_GMAIL_ENABLED:'true',HARBOR_PORTABLE_WORKFLOW_GMAIL_ENABLED:'true',HARBOR_PORTABLE_GMAIL_OWNER:'owner@example.test'});
      Object.assign(env,calendar.env,{HARBOR_PUBLIC_AVAILABILITY_ENABLED:'true'});
      await start();
      await sharing.verifyKnowledge();
      await verifyPortableCalendar({request,origin,headers,other,calendar,enabled:true});
      const heldId=randomUUID();
      sharing.availabilityId=await verifyPublishedAvailability({
        request,origin,owner:headers,other,providerCalls:calendar.calls,hold:async({start,end})=>{
          await sql`INSERT INTO portable_calendar_meetings
            (workspace_id,id,contact_id,owner_id,account_id,input,start_at,end_at,created_at,status)
            SELECT c.workspace_id,${heldId},c.id,w.owner_id,'owner@example.test','{}',${Date.parse(start)},${Date.parse(end)},${Date.now()},'attention'
            FROM contacts c JOIN private_workspaces w ON w.id=c.workspace_id WHERE c.id=${record.id}`;
        },
      });
      assert.equal((await sql`DELETE FROM portable_calendar_meetings WHERE id=${heldId} RETURNING id`).length,1);
      t.diagnostic('Public availability link verified with revocation, saved holds and no Google calls.');
      const guestPost=(id,body,site=origin)=>request('/api/public/availability/'+id,{method:'POST',
        headers:{origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
      assert.equal((await guestPost(sharing.availabilityId,{})).status,404);
      await stop();
      env.HARBOR_GUEST_BOOKING_PROOF_ENABLED='true';
      Object.assign(env,{HARBOR_PORTABLE_GMAIL_CLIENT_ID:'guest-proof-client',HARBOR_PORTABLE_GMAIL_CLIENT_SECRET:'guest-proof-secret',
        HARBOR_PORTABLE_GMAIL_REFRESH_TOKEN:'guest-proof-refresh'});
      env.HARBOR_PORTABLE_CALENDAR_INVITES_ENABLED='true';
      env.HARBOR_GUEST_BOOKING_INVITES_ENABLED='true';
      await start();
      const [published]=await sql`SELECT slots FROM portable_published_availability WHERE id=${sharing.availabilityId}`;
      const readOnlyRequest={action:'request',requestId:randomUUID(),email:'guest-proof@example.test',start:published.slots[0].start};
      assert.equal((await guestPost(sharing.availabilityId,readOnlyRequest)).status,404);
      const nextAvailabilityId=randomUUID();
      const enableGuestProof=await request('/api/calendar/availability-page',{method:'POST',
        headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify({action:'publish',
          id:nextAvailabilityId,previousId:sharing.availabilityId,title:'Guest verification',timeZone:'UTC',
          slots:published.slots,allowGuestProof:true})});
      assert.equal(enableGuestProof.status,200);
      assert.equal((await guestPost(sharing.availabilityId,{action:'verify',requestId:randomUUID(),code:'a'.repeat(43)})).status,404);
      const previousAvailabilityId=sharing.availabilityId;
      sharing.availabilityId=nextAvailabilityId;
      const guestPage=await request('/availability/'+sharing.availabilityId);
      assert.match(await guestPage.text(),/Email me a code/);
      const bookingLogStart=logs.length;
      await sql.unsafe(`CREATE FUNCTION harbor_test_guest_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'private-guest-cleanup-failure-fixture'; END $$;
        CREATE TRIGGER harbor_test_guest_cleanup_failure BEFORE DELETE ON portable_guest_booking_requests
        FOR EACH STATEMENT EXECUTE FUNCTION harbor_test_guest_cleanup_failure()`).simple();
      let statusReceipt;
      try{
        statusReceipt=await verifyGuestBooking({post:guestPost,start:published.slots[0].start,pageId:sharing.availabilityId,
          mail:async()=>(await readFile(guestProofLog,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),
          inspect:async id=>(await sql`SELECT * FROM portable_guest_booking_requests WHERE id=${id}`)[0],
          suppress:email=>sql`INSERT INTO portable_email_suppressions (workspace_id,id,email,created_at)
            VALUES (${sharing.workspaceId},${randomUUID()},${email},now())`,
          expire:id=>sql`UPDATE portable_guest_booking_requests SET expires_at=0 WHERE id=${id}`,
        });
        const bookingLogs=logs.slice(bookingLogStart);
        assert.deepEqual(bookingLogs.split('\n').filter(line=>line.includes('"event":"harbor_portable_guest_request_cleanup_failed"')),
          ['{"event":"harbor_portable_guest_request_cleanup_failed"}']);
        assert.ok(!bookingLogs.includes('private-guest-cleanup-failure-fixture'));
      }finally{
        await sql.unsafe('DROP TRIGGER harbor_test_guest_cleanup_failure ON portable_guest_booking_requests; DROP FUNCTION harbor_test_guest_cleanup_failure()').simple();
      }
      sharing.guestStatusReceipt=statusReceipt;
      const statusPost=(receipt,site=origin)=>request('/api/public/booking-status',{method:'POST',
        headers:{origin:site,'content-type':'application/json'},body:JSON.stringify({receipt})});
      const statusPage=await request('/booking-status');
      assert.equal(statusPage.status,200);
      assert.equal(statusPage.headers.get('cache-control'),'no-store');
      assert.equal(statusPage.headers.get('referrer-policy'),'no-referrer');
      assert.equal(statusPage.headers.has('set-cookie'),false);
      assert.match(await statusPage.text(),/Booking status/);
      assert.equal((await statusPost(statusReceipt,'https://outside.example.test')).status,403);
      await verifyGuestStatusRead(statusPost,statusReceipt,published.slots[0].start,published.slots[0].end);
      const ownerAvailability=await (await request('/api/calendar/availability-page',{headers})).json();
      assert.equal(ownerAvailability.verifiedRequests.length,1);
      assert.equal(ownerAvailability.verifiedRequests[0].email,'guest-proof@example.test');
      assert.deepEqual(Object.keys(ownerAvailability.verifiedRequests[0]).sort(),['email','end','id','invitation','start','verifiedAt']);
      assert.equal((await request('/api/calendar/availability-page',{headers:other})).status,403);
      assert.doesNotMatch(await (await request('/availability/'+sharing.availabilityId)).text(),/guest-proof@example\.test/);
      const callsBeforePagination=await calendar.calls();
      await verifyPortableBookingPagination({request,headers,other,sql,workspaceId:sharing.workspaceId,
        pageId:sharing.availabilityId,previousPageId:previousAvailabilityId,slot:published.slots[0]});
      assert.deepEqual(await calendar.calls(),callsBeforePagination);
      t.diagnostic('Guest proof accepted one simulated Gmail send despite a lost provider response.');
      const calendarInvites=await verifyPortableInvites({request,origin,headers,other,signIn,calendar,sql});
      await stop();
      env.HARBOR_PORTABLE_CALENDAR_CANCELLATIONS_ENABLED='true';
      env.HARBOR_PORTABLE_CALENDAR_RESCHEDULES_ENABLED='true';
      await start();
      await verifyPortableCancellations({request,origin,headers,other,signIn,calendar,sql,meetings:calendarInvites});
      const calendarReschedules=await verifyPortableReschedules({request,origin,headers,other,calendar,sql});
      await verifyPortableCalendarMonitor({sql,meetings:calendarInvites,reschedules:calendarReschedules,env,directory});
      await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
      const guestInvitation=(auth=headers,site=origin)=>request('/api/calendar/guest-invitations',{method:'POST',
        headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify({
          pageId:sharing.availabilityId,requestId:ownerAvailability.verifiedRequests[0].id,
        })});
      assert.equal((await guestInvitation(other)).status,403);
      assert.equal((await guestInvitation(headers,'https://outside.example.test')).status,403);
      assert.match((await (await guestInvitation()).json()).error,/Create a Contact/);
      const guestContact=randomUUID();
      await sql`INSERT INTO contacts (workspace_id,id,revision,data,created_at,updated_at)
        VALUES (${sharing.workspaceId},${guestContact},1,${sql.json({name:'Verified guest',email:'guest-proof@example.test'})},now(),now())`;
      const [calendarOwner]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${sharing.workspaceId}`;
      const writeBudget=async()=>(await sql`SELECT minute,used FROM portable_request_budgets
        WHERE scope='api_write' AND subject=${calendarOwner.owner_id}`)[0];
      const availabilityWindow={start:new Date(Date.now()+3600000).toISOString(),
        end:new Date(Date.now()+5400000).toISOString(),timeZone:'UTC'};
      const preferences='/api/email/suppressions',manualBlockId=randomUUID();
      const pendingWorkspaceInvitation=()=>sql`SELECT id,role FROM portable_workspace_invites
        WHERE workspace_id=${sharing.workspaceId} AND id=${sharing.invitationId}`;
      const [workspaceInvitation]=await pendingWorkspaceInvitation();
      assert.deepEqual(workspaceInvitation,{id:sharing.invitationId,role:'viewer'});
      const tokenSettings='/api/api-tokens';
      const tokenInput={name:'Fictional session token',objects:['contacts'],permission:'read',days:30};
      const tokenFixture=await request(tokenSettings,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
        body:JSON.stringify(tokenInput)});
      assert.equal(tokenFixture.status,201);
      const {info:{id:sessionTokenId}}=await tokenFixture.json();
      const tokenRows=()=>sql`SELECT id,revoked_at FROM portable_api_tokens WHERE workspace_id=${sharing.workspaceId}
        AND issuer_id=${calendarOwner.owner_id} ORDER BY id`;
      const originalTokenRows=await tokenRows();
      assert.ok(originalTokenRows.some(row=>row.id===sessionTokenId&&row.revoked_at===null));
      const manualBlock=await request(preferences,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
        body:JSON.stringify({id:manualBlockId,email:'session-check@example.test'})});
      assert.equal(manualBlock.status,200);
      for(const [path,input,method='POST'] of [
        ['/api/calendar/availability',availabilityWindow],
        ['/api/calendar/availability-page',{action:'unpublish',id:sharing.availabilityId}],
        ['/api/calendar/guest-invitations',{pageId:sharing.availabilityId,requestId:ownerAvailability.verifiedRequests[0].id}],
        ['/api/calendar/meetings',{action:'check',id:calendarInvites.pendingId}],
        [preferences,{id:manualBlockId},'DELETE'],
        ['/api/workspaces',{action:'invite_role',id:workspaceInvitation.id,role:'editor'}],
        [tokenSettings,{...tokenInput,name:'Fictional pending token'}],
        [tokenSettings,{action:'revoke',id:sessionTokenId}],
      ]){
        const shortSession=await signIn('owner@example.test'),before=await writeBudget(),calls=await calendar.calls();
        let stream;
        const body=new ReadableStream({start(controller){stream=controller;controller.enqueue(new TextEncoder().encode('{'));}});
        const pending=request(path,{method,headers:{...shortSession,origin,'content-type':'application/json'},body,duplex:'half'});
        void pending.catch(()=>{});
        try{
          let admitted=false;
          for(let attempt=0;attempt<100;attempt++){
            const budget=await writeBudget();
            if(budget&&(budget.minute!==before?.minute||budget.used!==before?.used)){admitted=true;break;}
            await delay(10);
          }
          assert.equal(admitted,true,'Request was admitted before sign-out');
          const signOut=await request('/auth/logout',{method:'POST',headers:{...shortSession,origin},
            body:new URLSearchParams({scope:'current'})});
          assert.equal(signOut.status,303);
        }finally{
          stream.enqueue(new TextEncoder().encode(JSON.stringify(input).slice(1)));
          stream.close();
        }
        const denied=await pending;
        assert.equal(denied.status,403,path===tokenSettings?'Ended session cannot change API tokens':await denied.clone().text());
        if(path==='/api/workspaces'){
          assert.equal(denied.headers.get('cache-control'),'private, no-store');
          assert.deepEqual((await pendingWorkspaceInvitation())[0],workspaceInvitation);
        }
        if(path===tokenSettings){
          assert.equal(denied.headers.get('cache-control'),'private, no-store');
          assert.deepEqual(await tokenRows(),originalTokenRows);
        }
        assert.deepEqual(await calendar.calls(),calls,'revoked request does not contact Calendar');
        assert.equal((await sql`SELECT count(*)::int AS n FROM portable_published_availability WHERE id=${sharing.availabilityId}`)[0].n,1);
        assert.equal((await sql`SELECT count(*)::int AS n FROM portable_calendar_meetings WHERE contact_id=${guestContact}`)[0].n,0);
      }
      await sql`DELETE FROM portable_api_tokens WHERE workspace_id=${sharing.workspaceId} AND id=${sessionTokenId}`;
      assert.equal((await sql`SELECT count(*)::int AS n FROM portable_email_suppressions
        WHERE workspace_id=${sharing.workspaceId} AND id=${manualBlockId}`)[0].n,1);
      const removed=await request(preferences,{method:'DELETE',headers:{...headers,origin,'content-type':'application/json'},
        body:JSON.stringify({id:manualBlockId})});
      assert.equal(removed.status,200);
      assert.equal((await sql`SELECT count(*)::int AS n FROM portable_email_suppressions
        WHERE workspace_id=${sharing.workspaceId} AND id=${manualBlockId}`)[0].n,0);
      const readSession=await signIn('owner@example.test'),beforeRead=(await calendar.calls()).length;
      await calendar.mode('hold');
      const pendingRead=request('/api/calendar/availability',{method:'POST',
        headers:{...readSession,origin,'content-type':'application/json'},body:JSON.stringify(availabilityWindow)});
      void pendingRead.catch(()=>{});
      try{
        let started=false;
        for(let attempt=0;attempt<100;attempt++){
          if((await calendar.calls()).slice(beforeRead).includes('availability')){started=true;break;}
          await delay(10);
        }
        assert.equal(started,true,'Google was already checking availability before sign-out');
        const signOut=await request('/auth/logout',{method:'POST',headers:{...readSession,origin},
          body:new URLSearchParams({scope:'current'})});
        assert.equal(signOut.status,303);
      }finally{await calendar.mode('free');}
      const discarded=await pendingRead;
      assert.equal(discarded.status,403,await discarded.clone().text());
      assert.deepEqual(await discarded.json(),{error:'Sign in again to check Calendar availability.'});
      assert.deepEqual((await calendar.calls()).slice(beforeRead),['token','identity','availability']);

      const invites=async()=>(await calendar.calls()).filter(call=>call==='invite').length;
      const beforeGuestInvite=await invites();
      await calendar.mode('busy');
      assert.equal((await guestInvitation()).status,409);
      assert.equal(await invites(),beforeGuestInvite);
      await calendar.mode('lost');
      const guestInvites=await Promise.all([guestInvitation(),guestInvitation()]);
      assert.ok(guestInvites.every(response=>response.ok));
      const guestReceipts=await Promise.all(guestInvites.map(response=>response.json()));
      assert.ok(guestReceipts.some(receipt=>receipt.status==='attention'));
      assert.deepEqual(await (await statusPost(statusReceipt)).json(),{state:'checking'});
      assert.equal(await invites(),beforeGuestInvite+1);
      const guestMeetingId=guestReceipts[0].id;
      assert.equal((await (await guestInvitation()).json()).status,'attention');
      await calendar.mode('free');
      const confirmed=await request('/api/calendar/meetings',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
        body:JSON.stringify({action:'check',id:guestMeetingId})});
      assert.equal((await confirmed.json()).status,'scheduled');
      const proofStatus=await (await request('/api/calendar/availability-page',{headers})).json();
      assert.equal(proofStatus.verifiedRequests[0].invitation.status,'scheduled');
      assert.equal(await invites(),beforeGuestInvite+1);
      const confirmedStatus={state:'confirmed',...published.slots[0]};
      assert.deepEqual(await (await statusPost(statusReceipt)).json(),confirmedStatus);
      const unpublish=await request('/api/calendar/availability-page',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
        body:JSON.stringify({action:'unpublish',id:sharing.availabilityId})});
      assert.equal(unpublish.status,200);
      assert.deepEqual(await (await statusPost(statusReceipt)).json(),confirmedStatus);
      t.diagnostic('Private guest status survived link revocation and omitted identifiers and Google URLs.');
      t.diagnostic('Confirmed a verified guest through one simulated Calendar invite and recovered its lost receipt.');

      await verifyPortableScheduledGmail({request,origin,headers,other,sql,env,sharing,directory});
      const inboxLookup=()=>request('/api/email/inbox',{method:'POST',headers:{...headers,origin,
        'content-type':'application/json'},body:JSON.stringify({recordId:sharing.gmail.contactId})});
      assert.equal((await inboxLookup()).status,404);
      await stop();
      const oldMode=env.HARBOR_PORTABLE_MODE;
      Object.assign(env,inbox.env,{HARBOR_PORTABLE_MODE:'local',HARBOR_PORTABLE_GMAIL_ENABLED:'false',HARBOR_PORTABLE_WORKFLOW_GMAIL_ENABLED:'false'});
      await start();
      sharing.neverLog=await verifyPortableInbox({request,origin,headers,other,sql,workspaceId:sharing.workspaceId,
        contactId:sharing.gmail.contactId,foreignContactId:otherRecord.id,missingContactId:secondRecord.id,inbox});
      await stop();
      for(const key of Object.keys(inbox.env))delete env[key];
      if(oldMode===undefined)delete env.HARBOR_PORTABLE_MODE;else env.HARBOR_PORTABLE_MODE=oldMode;
      Object.assign(env,{HARBOR_PORTABLE_GMAIL_ENABLED:'true',HARBOR_PORTABLE_WORKFLOW_GMAIL_ENABLED:'true'});
      await start();

      await verifyPortableJobOperations({request,origin,headers,other,sql,sharing,record});
      await verifyPortableNoteRetry({request,origin,headers,other,sql,sharing,record,env});
      sharing.savedViews=await verifyPortableSavedViews({request,origin,headers,other,sql,sharing});
      sharing.memberView=await verifyPortableMemberSavedViews({request,origin,headers,other,sql,sharing});
      if(process.env.HARBOR_TEST_RESTORE_POSTGRES_URL){
        sharing.additionalImports=await seedAdditionalImportRecovery({request,origin,headers});
      }
      sharing.verifyTaskQueues=await verifyPortableTaskQueues({request,origin,headers,other,sharing,sql});
      sharing.recordActivities=await verifyPortableRecordActivities({request,origin,headers,other,sql,sharing,
        contact:restartedContact,company:updatedCompany,deal:updatedDeal,otherCompany,otherDeal});
      sharing.activityMutations=await verifyPortableActivityMutations({request,origin,headers,other,sql,sharing});
      sharing.dealStageProperties=await verifyPortableDealStageProperties({request,origin,headers,other,sql,sharing,contact:restartedContact});
      sharing.contactArchive=await verifyPortableContactArchiveReads({request,origin,headers,other,record,sql,sharing,fixture,env});
      sharing.archiveOperation=await verifyPortableContactArchive({request,origin,headers,other,sql});
      sharing.companyArchive=await verifyPortableCompanyArchive({request,origin,headers,other,sql,sharing});
      sharing.dealArchive=await verifyPortableDealArchive({request,origin,headers,other,sql,sharing});
      sharing.sharedArchive=await verifyPortableSharedArchive({request,origin,headers,other,sql,sharing});
      sharing.bulkActions=await verifyPortableBulkActions({request,origin,headers,other,sql,sharing});
      sharing.bulkProperties=await verifyPortableBulkProperties({request,origin,headers,other,sql,sharing});
      sharing.bulkStage=await verifyPortableBulkStage({request,origin,headers,other,sql,sharing});
      sharing.companyMerge=await verifyPortableCompanyMerge({request,origin,headers,other,sql,sharing});
      sharing.contactMerge=await verifyPortableContactMerge({request,origin,headers,other,sql,sharing,env});
      await verifyPortableDuplicates({request,origin,headers,other,sql,sharing});
      sharing.sharedLead=await verifyPortableSharedLeads({request,origin,headers,other,sql,sharing});
      sharing.taskRepeats=await verifyPortableTaskRepeats({request,origin,headers,other,sql,sharing,env});
      sharing.reports=await verifyPortableReports({request,origin,headers,other,sql,workspaceId:sharing.workspaceId});
      await verifyPortableReportCustomFilters({request,origin,headers,sql,workspaceId:sharing.workspaceId});
      sharing.segment=await verifyPortableSegments({request,origin,headers,other,sql,workspaceId:sharing.workspaceId});
      sharing.staticSegments=await verifyPortableStaticSegments({request,origin,headers,other,sql});
      sharing.dashboard=await verifyPortableDashboards({request,origin,headers,other,sql,workspaceId:sharing.workspaceId,reports:sharing.reports});
      await verifyPortableManagerFollowUp({request,headers,other,sql});
      t.diagnostic('Private and shared saved views preserved filters, pagination and workspace revocation.');
      sharing.calendarInvites=calendarInvites;
      sharing.calendarReschedules=calendarReschedules;
      await verifyPortableCrmSearch({request,origin,headers,other,sql,sharing,company:updatedCompany,deal:updatedDeal});
      sharing.verifyExternalApiRestore=await verifyPortableExternalApi({request,origin,headers,other,record,otherRecord,
        company:updatedCompany,deal:updatedDeal,sql,inquiryTimeline:sharing.inquiryTimeline});
      sharing.segmentWorkflow=await verifyPortableSegmentWorkflow({request,origin,headers,other,sql,env});
      sharing.formNotes=await verifyPortableFormNotes({request,origin,headers,other,sql,env,sharing});
      await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
      const webhook=await verifyLeadWebhook({request:(path,init,actor)=>request(path,{
        ...init,headers:{...init.headers,...actor},
      }),origin,owner:headers,other});
      assert.equal((await sql`SELECT count(*)::int AS n FROM contacts WHERE data->>'email'=${'webhook-'+webhook.id+'@example.test'}`)[0].n,0);
      assert.equal((await sql`SELECT count(*)::int AS n FROM portable_lead_form_note_sources WHERE inquiry_id=${webhook.inquiryId}`)[0].n,0);
      sharing.recordOwners=await verifyPortableRecordOwners({request,origin,headers,other,sql,sharing});
      sharing.ticketSla=await verifyPortableTicketSla({request,origin,headers,other,sql,workspaceId:sharing.workspaceId});
      if(process.env.HARBOR_TEST_RESTORE_POSTGRES_URL){
        assert.ok(fixture,'The restore rehearsal needs a source S3 test endpoint.');
        await verifyPortableRecovery({env,mock,request,headers,record,otherRecord,sql,directory,signIn,
          company:updatedCompany,otherCompany,deal:updatedDeal,otherDeal,sharing});
        t.diagnostic('Scheduled backup and recovery ran with two Node, Postgres and S3-compatible instances.');
      }
      await verifyPortableHosting({env,mock,signIn,prepareSignIn,record,otherRecord,request,sourceOwner:headers,other,sql,
        inbox,inboxContactId:sharing.gmail.contactId,
        restartSource:async()=>{await stop();await start();}});
      t.diagnostic('Hosted-mode proxy, readiness and shared rate-limit checks ran with fictional credentials.');
      await verifyPortableGuestSignIn({request,origin,headers,other,prepareSignIn,signIn,sql,env,record,workspaceId:sharing.workspaceId,
        restart:async()=>{await stop();await start();}});
      const logout=origin=>request('/auth/logout',{method:'POST',headers:{...headers,origin},body:new URLSearchParams({scope:'current'})});
      assert.equal((await logout('https://outside.example.test')).status,403);
      const rejectedLogout=await request('/auth/logout',{method:'POST',headers:{...headers,origin},
        body:new URLSearchParams({scope:'all',padding:'x'.repeat(512)})});
      assert.equal(rejectedLogout.status,413);
      assert.equal(rejectedLogout.headers.get('cache-control'),'no-store');
      assert.equal((await request('/',{headers})).status,200);
      assert.equal((await logout(origin)).status,303);
      assert.match((await request('/',{headers})).headers.get('location'),/\/auth\/sign-in/);
      assert.equal((await sql`SELECT token_hash FROM login_sessions`).length,1);
    }catch(error){
      if(logs?.trim())t.diagnostic(logs.trim());
      throw error;
    }finally{
      await stop();
      fixture?.storage.destroy();
      await sql.end();
      await rm(directory,{recursive:true,force:true});
    }
  });
