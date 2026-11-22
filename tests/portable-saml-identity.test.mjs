import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {randomBytes,randomUUID,X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {exportJWK,generateKeyPair,SignJWT} from 'jose';
import postgres from 'postgres';
import {CreateBucketCommand} from '@aws-sdk/client-s3';
import {localFileFixture} from './portable-files-fixture.mjs';
import {samlDirectoryLifecycle} from './portable-saml-directory-fixture.mjs';
import {samlProvider} from './portable-saml-provider-fixture.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const database=process.env.HARBOR_TEST_POSTGRES_URL;
const owner='saml-owner@example.test',employee='saml-employee@example.test',googleEmail='independent@example.test';
const ownerId='directory-person-781',employeeId='directory-person-912',issuer='https://directory.example.test/tenant';
const returnTo='/?view=workspaces';

async function browserSignIn(origin,idp){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext();
    const page=await context.newPage();
    await page.goto(origin+'/auth/sign-in?return_to='+encodeURIComponent(returnTo));
    await page.getByText('Continue with company SSO',{exact:true}).click();
    await page.waitForURL(url=>url.origin===new URL(idp.entryPoint).origin);
    const pending=(await context.cookies()).find(cookie=>cookie.name==='__Host-harbor-saml-attempt'&&cookie.domain===new URL(origin).hostname);
    assert.deepEqual([pending?.httpOnly,pending?.secure,pending?.sameSite,pending?.path],[true,true,'None','/']);
    await page.getByRole('button',{name:'Continue as fictional operator'}).click();
    await page.waitForURL(origin+returnTo);
    assert.ok((await context.cookies(origin)).some(cookie=>cookie.name==='harbor-session'));
    const shared=await context.request.get(origin+'/api/workspaces');
    assert.equal(shared.status(),200);
    assert.ok((await shared.json()).owned);
  }finally{await browser.close();}
}

async function verifyCertificateRollover({dir,env,idp,startWeb,saml,expectReturn,disabled,get,workspace}){
  const keyPath=join(dir,'next-signing.key'),certPath=join(dir,'next-signing.pem');
  await promisify(execFile)('openssl',['req','-new','-x509','-nodes','-newkey','rsa:2048','-days','1',
    '-subj','/CN=Fictional replacement signer','-keyout',keyPath,'-out',certPath]);
  const [newKey,newCert]=await Promise.all([readFile(keyPath,'utf8'),readFile(certPath,'utf8')]);
  const current=env.HARBOR_LOGIN_SAML_CERT;
  const metadataPath=join(dir,'provider-metadata.xml');
  const signing=pem=>'<KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>'+
    new X509Certificate(pem).raw.toString('base64')+'</ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor>';
  function providerMetadata(keys){
    return '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="'+issuer+'">'+
      '<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">'+keys+
      '<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="'+idp.entryPoint+'"/>'+
      '</IDPSSODescriptor></EntityDescriptor>';
  }
  async function compare(xml,status){
    await writeFile(metadataPath,xml);
    const command=['scripts/portable-web.mjs','doctor','web','--saml-metadata',metadataPath];
    const {stdout,code}=await promisify(execFile)(process.execPath,command,{cwd:root,env})
      .then(result=>({...result,code:0}),error=>{if(error.code!==1)throw error;return error;});
    assert.equal(code,status==='ok'?0:1,stdout);
    assert.ok(!stdout.includes('BEGIN CERTIFICATE')&&!stdout.includes(env.HARBOR_LOGIN_SAML_ATTEMPT_SECRET));
    const report=JSON.parse(stdout);
    assert.equal(report.checks.samlMetadata,status);
    assert.equal(report.result,status==='ok'?'ready':'needs_setup');
    return report.samlMetadataComparison;
  }
  const published=providerMetadata(signing(current)+signing(newCert));
  const fingerprint=pem=>new X509Certificate(pem).fingerprint256;
  assert.deepEqual((await compare(published,'provider_certificate_missing')).providerOnly,[fingerprint(newCert)]);
  await compare('<broken','invalid_metadata');
  await compare(providerMetadata(signing(current).replace('use="signing"','use="encryption"')),'no_signing_certificate');
  await compare(published.replace(issuer,'urn:another-company'),'issuer_mismatch');
  await compare(published.replace('HTTP-Redirect','HTTP-POST'),'redirect_mismatch');
  await compare(providerMetadata(signing(current).replace('use="signing"','use="encryption"')+signing(newCert)),'no_matching_certificate');
  async function checkConfiguredCertificates(pems){
    const {stdout}=await promisify(execFile)(process.execPath,['scripts/portable-web.mjs','doctor','web'],{cwd:root,env});
    const report=JSON.parse(stdout);
    assert.equal(report.checks.samlSignIn,'ok');
    assert.deepEqual(report.samlSigningCertificates,pems.map(pem=>{
      const cert=new X509Certificate(pem);
      return {sha256:cert.fingerprint256,expiresAt:cert.validToDate.toISOString()};
    }));
    assert.ok(!stdout.includes('BEGIN CERTIFICATE'));
  }
  const inProgress=await saml(ownerId);

  env.HARBOR_LOGIN_SAML_CERT=(current.trim()+'\n'+newCert.trim()).replaceAll('\n','\\n');
  await startWeb();
  await checkConfiguredCertificates([current,newCert]);
  assert.deepEqual(await compare(published,'ok'),{status:'ok',providerOnly:[],harborOnly:[]});
  const retired=await compare(providerMetadata(signing(newCert)),'ok');
  assert.deepEqual(retired.harborOnly,[fingerprint(current)]);
  const existingSession=expectReturn(await inProgress());
  expectReturn(await (await saml(ownerId))());
  const oldResponse=await saml(ownerId);
  idp.useSigningKey(newKey);
  expectReturn(await (await saml(ownerId))());
  const newResponse=await saml(ownerId);

  env.HARBOR_LOGIN_SAML_CERT=newCert;
  await startWeb();
  await checkConfiguredCertificates([newCert]);
  disabled(await oldResponse());
  const currentSession=expectReturn(await newResponse());
  for(const cookie of [existingSession,currentSession]){
    const response=await get('/api/workspaces',cookie);
    assert.equal(response.status,200);
    assert.equal((await response.json()).owned,workspace);
  }

  for(const invalid of [newCert+'\ninvalid certificate',current+newCert+current]){
    env.HARBOR_LOGIN_SAML_CERT=invalid;
    await startWeb();
    assert.equal((await get('/auth/saml/metadata','')).status,404);
  }
  env.HARBOR_LOGIN_SAML_CERT=newCert;
  await startWeb();
}

const useKeycloak=process.env.HARBOR_TEST_KEYCLOAK==='true';
test(useKeycloak?'Keycloak signs in an owner and invited employee and Harbor enforces revocation':'Portable company SSO signs in an operator and follows an employee through invitation and revocation',
  {skip:!database,timeout:180000},async()=>{
    const db=new URL(database);
    assert.equal(db.hostname,'127.0.0.1');assert.match(db.pathname,/^\/harbor_identity_test(?:_[a-z0-9]+)?$/);
    const name='harbor_saml_identity_'+randomUUID().replaceAll('-',''),admin=postgres(db.href,{max:1,onnotice:()=>{}});
    const dir=await mkdtemp(join(tmpdir(),'harbor-saml-'));
    const files=localFileFixture();
    let idp,sql,app,exited,created=false,logs='';
    try{
      const listener=createServer().listen(0,'127.0.0.1');await once(listener,'listening');
      const {port}=listener.address();await new Promise(resolve=>listener.close(resolve));
      const origin='http://127.0.0.1:'+port,fixtureFile=join(dir,'google-test.json');
      const key=useKeycloak?undefined:await readFile(process.env.HARBOR_TEST_TLS_KEY,'utf8');
      const cert=useKeycloak?undefined:await readFile(process.env.NODE_EXTRA_CA_CERTS,'utf8');
      if(!useKeycloak)idp=await samlProvider({origin,issuer,ownerNameId:ownerId,key});
      await admin`CREATE DATABASE ${admin(name)}`;created=true;db.pathname='/'+name;
      sql=postgres(db.href,{max:1,onnotice:()=>{}});
      assert.ok(files,'Run the SAML rehearsal with the disposable storage fixture.');
      await files.storage.send(new CreateBucketCommand({Bucket:files.bucket}));
      const env={...files.env,PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:dir,PORT:String(port),DATABASE_URL:db.href,
        HARBOR_PORTABLE_MODE:'local',HARBOR_LOGIN_ORIGIN:origin,HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED:'true',
        HARBOR_LOGIN_ALLOWED_EMAILS:useKeycloak?owner:[owner,googleEmail].join(','),
        ...(useKeycloak?{}:{HARBOR_LOGIN_GOOGLE_CLIENT_ID:'google-saml-trial',HARBOR_LOGIN_GOOGLE_CLIENT_SECRET:'fictional-provider-secret',
          HARBOR_TEST_MICROSOFT_IDENTITY_FIXTURE:fixtureFile}),
        HARBOR_LOGIN_SAML_ISSUER:issuer,HARBOR_LOGIN_SAML_ENTRY_POINT:idp?.entryPoint,HARBOR_LOGIN_SAML_CERT:cert,
        HARBOR_LOGIN_SAML_BINDINGS:JSON.stringify({[ownerId]:owner,[employeeId]:employee}),
        HARBOR_LOGIN_SAML_ATTEMPT_SECRET:randomBytes(32).toString('base64url')};
      await promisify(execFile)(process.execPath,['scripts/portable-web.mjs','migrate'],{cwd:root,env});
      const request=(path,options={})=>fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(8000),...options});
      async function startWeb(){
        if(app&&app.exitCode===null&&app.signalCode===null){app.kill();await exited;}
        const preload=useKeycloak||env.HARBOR_LOGIN_OIDC_ISSUER?[]:['--import','./tests/portable-microsoft-provider-fixture.mjs'];
        app=spawn(process.execPath,[...preload,'scripts/portable-web.mjs','start'],
          {cwd:root,env,stdio:['ignore','pipe','pipe']});
        exited=once(app,'exit');for(const stream of [app.stdout,app.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-2500);});
        for(let i=0;i<120&&app.exitCode===null;i++){
          if((await request('/healthz').catch(()=>null))?.ok)return;
          await delay(100);
        }
        assert.fail('Local SAML web service did not start. '+logs);
      }
      if(useKeycloak){
        const {verifyKeycloak}=await import('./portable-keycloak-fixture.mjs');
        await verifyKeycloak({origin,dir,env,owner,employee,ownerId,employeeId,startWeb});
        return;
      }
      await startWeb();
      const get=(path,cookie)=>request(path,{headers:{cookie}});
      const json=(path,cookie,body)=>request(path,{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify(body)});
      const checked=async(pending,status=200)=>{const r=await pending;assert.equal(r.status,status,await r.clone().text());return r.json();};
      const session=response=>response.headers.getSetCookie().find(value=>value.startsWith('harbor-session=')&&!value.startsWith('harbor-session=;'))?.split(';')[0];
      const disabled=reply=>{
        const url=new URL(reply.headers.get('location'),origin);
        assert.equal(reply.status,303);assert.equal(url.pathname,'/auth/sign-in');
        assert.ok(url.searchParams.has('error'));assert.equal(session(reply),undefined);
      };
      const expectReturn=(reply,path=returnTo)=>{
        assert.equal(reply.status,303);assert.equal(new URL(reply.headers.get('location'),origin).href,origin+path,logs);
        const cookie=session(reply);assert.ok(cookie);return cookie;
      };
      async function saml(nameId,path=returnTo,signing={},priorCookie){
        const start=await request('/auth/saml/start?return_to='+encodeURIComponent(path),priorCookie?{headers:{cookie:priorCookie}}:{});
        assert.equal(start.status,303,logs);
        const redirect=new URL(start.headers.get('location'));
        assert.equal(redirect.origin+redirect.pathname,idp.entryPoint);
        const body=idp.responseFor(redirect,nameId,signing);
        const attempt=start.headers.getSetCookie().find(value=>value.startsWith('__Host-harbor-saml-attempt='))?.split(';')[0];
        assert.ok(attempt);
        return (cookie=attempt)=>request('/auth/saml/callback',{method:'POST',headers:{origin:redirect.origin,...(cookie?{cookie}:{})},body});
      }
      const googleKeys=await generateKeyPair('RS256');
      async function google(email){
        const start=await request('/auth/google/start?return_to='+encodeURIComponent(returnTo));assert.equal(start.status,303);
        const redirect=new URL(start.headers.get('location')),query=redirect.searchParams,code=randomUUID();
        assert.equal(redirect.origin,'https://accounts.google.com');
        const claims={sub:'google-'+email,email,email_verified:true,nonce:query.get('nonce')};
        const token=await new SignJWT(claims).setProtectedHeader({alg:'RS256',kid:'google'}).setIssuer('https://accounts.google.com')
          .setAudience(env.HARBOR_LOGIN_GOOGLE_CLIENT_ID).setIssuedAt().setExpirationTime('5m').sign(googleKeys.privateKey);
        const jwk={...await exportJWK(googleKeys.publicKey),kid:'google',alg:'RS256',use:'sig'};
        await writeFile(fixtureFile,JSON.stringify({keys:{google:jwk},code,token,challenge:query.get('code_challenge')}),{mode:0o600});
        return get('/auth/google/callback?'+new URLSearchParams({code,state:query.get('state')}),start.headers.getSetCookie()[0].split(';')[0]);
      }

      const metadata=await request('/auth/saml/metadata');assert.equal(metadata.status,200);
      const xml=await metadata.text();
      assert.ok(xml.includes('entityID="'+origin+'/auth/saml/metadata"'));assert.ok(xml.includes(origin+'/auth/saml/callback'));
      const independent=expectReturn(await google(googleEmail));
      disabled(await (await saml(ownerId,returnTo,{assertionIssuer:issuer+'/other-registration'}))());
      disabled(await (await saml(ownerId,returnTo,{signResponse:false}))());
      disabled(await (await saml(ownerId,returnTo,{responseDestination:origin+'/old-reply-url'}))());
      disabled(await (await saml(ownerId,returnTo,{responseIssuer:issuer+'/other-registration'}))());
      disabled(await (await saml(employeeId))());
      const first=await saml(ownerId);
      disabled(await first('')); // The provider form was posted from a different browser.
      const previousOwnerCookie=expectReturn(await first());
      const ownerCookie=expectReturn(await (await saml(ownerId,returnTo,{},previousOwnerCookie))());
      assert.notEqual(ownerCookie,previousOwnerCookie);
      assert.equal((await get('/api/workspaces',previousOwnerCookie)).status,401);
      disabled(await first()); // The original request has been consumed.
      disabled(await google(owner));
      disabled(await (await saml(googleEmail))());
      const {record}=await checked(json('/api/crm',ownerCookie,{action:'save',kind:'contacts',data:{name:'Fictional trade show lead'}}),201);
      const contact='/api/crm?kind=contacts&id='+record.id;
      assert.equal((await get(contact,independent)).status,404);
      const state=await checked(json('/api/workspaces',ownerCookie,{action:'invite',email:employee,role:'editor'}));
      const invite=state.sent.find(row=>row.email===employee);
      const employeeCookie=expectReturn(await (await saml(employeeId))());
      const accepted=await checked(json('/api/workspaces',employeeCookie,{action:'accept_invite',id:invite.id}));
      const grant=accepted.shared.find(row=>row.id===state.owned);assert.ok(grant);
      const sharedContact=contact+'&workspaceId='+grant.id;
      assert.equal((await checked(get(sharedContact,employeeCookie))).data.name,record.data.name);
      const updated=await checked(json('/api/workspaces',ownerCookie,{action:'contact_files',id:grant.grantId,enabled:true}));
      const editableGrant=updated.viewers.find(row=>row.email===employee).id;
      const file='/api/record-attachments?recordId='+record.id+'&fileId='+randomUUID(),bytes='Fictional employee case file';
      await checked(request(file+'&versionId='+randomUUID(),{method:'POST',headers:{cookie:ownerCookie,origin,'x-harbor-file-name':'case.txt'},body:bytes}));
      const linkedFile=file+'&workspaceId='+grant.id;
      assert.equal(await (await get(linkedFile,employeeCookie)).text(),bytes);

      const peerRecord=(await checked(json('/api/crm',independent,{action:'save',kind:'contacts',data:{name:'Second workspace Contact'}}),201)).record;
      const peer=await checked(json('/api/workspaces',independent,{action:'invite',email:employee,role:'viewer'}));
      const peerInvite=peer.sent.find(row=>row.email===employee);
      const joined=await checked(json('/api/workspaces',employeeCookie,{action:'accept_invite',id:peerInvite.id}));
      const otherGrant=joined.shared.find(row=>row.id===peer.owned);
      const peerContact='/api/crm?kind=contacts&id='+peerRecord.id+'&workspaceId='+peer.owned;
      await checked(json('/api/workspaces',ownerCookie,{action:'revoke',id:editableGrant}));
      assert.ok([403,404].includes((await get(sharedContact,employeeCookie)).status));
      assert.ok([403,404].includes((await get(linkedFile,employeeCookie)).status));
      const pendingEdit=await json('/api/crm?workspaceId='+grant.id+'&grantId='+editableGrant,employeeCookie,{
        action:'save',kind:'contacts',id:record.id,data:{name:'Stale employee edit'}});
      assert.ok([403,404].includes(pendingEdit.status));
      assert.equal((await checked(get(contact,ownerCookie))).data.name,record.data.name);
      assert.equal((await checked(get(peerContact,employeeCookie))).data.name,peerRecord.data.name);
      await checked(json('/api/workspaces',independent,{action:'revoke',id:otherGrant.grantId}));
      assert.equal((await get('/api/workspaces',employeeCookie)).status,401);
      disabled(await (await saml(employeeId))());
      const directoryEmails=await samlDirectoryLifecycle({request,json,get,checked,sql,env,startWeb,saml,expectReturn,disabled,google,
        ownerCookie,secondOwner:independent,workspace:state.owned,peerWorkspace:peer.owned,contact:sharedContact,peerContact,linkedFile,owner,employeeId});
      if(process.env.HARBOR_TEST_SAML_UI==='true'){
        const {verifySamlDirectorySettings}=await import('./portable-saml-directory-ui-fixture.mjs');
        directoryEmails.push(await verifySamlDirectorySettings(origin,ownerCookie));
      }
      const signedOut=await request('/auth/logout',{method:'POST',headers:{cookie:ownerCookie,origin},body:new URLSearchParams({scope:'all'})});
      assert.equal(signedOut.status,303);assert.equal((await get('/api/workspaces',ownerCookie)).status,401);
      assert.equal((await get('/api/workspaces',independent)).status,200);
      await verifyCertificateRollover({dir,env,idp,startWeb,saml,expectReturn,disabled,get,workspace:state.owned});
      // A pinned company SSO operator can bootstrap Entra employee sign-in without Google.
      delete env.HARBOR_LOGIN_GOOGLE_CLIENT_ID;
      delete env.HARBOR_LOGIN_GOOGLE_CLIENT_SECRET;
      Object.assign(env,{HARBOR_LOGIN_MICROSOFT_TENANT_ID:randomUUID(),HARBOR_LOGIN_MICROSOFT_CLIENT_ID:randomUUID(),
        HARBOR_LOGIN_MICROSOFT_CLIENT_SECRET:'directory-fixture-secret',HARBOR_LOGIN_MICROSOFT_BINDINGS:'{}',
        HARBOR_DIRECTORY_AUTHORITY_WORKSPACE_ID:state.owned,HARBOR_DIRECTORY_EMAIL_DOMAIN:'fixture.example'});
      await startWeb();
      assert.equal((await request('/auth/microsoft/start')).status,303);
      const samlOwner=expectReturn(await (await saml(ownerId))());
      assert.equal((await checked(get('/api/workspaces',samlOwner))).owned,state.owned);
      if(process.env.HARBOR_TEST_SAML_UI==='true')await browserSignIn(origin,idp);
      assert.deepEqual((await sql`SELECT email FROM login_identities ORDER BY email`).map(row=>row.email),[owner,employee,googleEmail,...directoryEmails].sort());
      const {verifyCompanyOidc}=await import('./portable-company-oidc-fixture.mjs');
      // Give the independent company issuer its own login-start window in this disposable database.
      await sql`DELETE FROM portable_request_budgets WHERE scope='login_start'`;
      await verifyCompanyOidc({origin,env,startWeb,request,expectReturn,disabled,checked,get,json,existingEmail:googleEmail});
      if(process.env.HARBOR_TEST_OIDC_PROVIDER){
        const {verifyOidcBrowser}=await import('./portable-oidc-browser-fixture.mjs');
        await verifyOidcBrowser({origin,env,startWeb});
      }
    }finally{
      if(app&&app.exitCode===null&&app.signalCode===null){app.kill();await exited;}
      files?.storage.destroy();
      await idp?.close();await sql?.end({timeout:3});
      if(created)await admin`DROP DATABASE ${admin(name)}`;
      await admin.end({timeout:3});await rm(dir,{recursive:true,force:true});
    }
  });
