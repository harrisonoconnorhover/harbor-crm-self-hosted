import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomBytes,randomUUID,X509Certificate} from 'node:crypto';
import {chmod,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {DOMParser} from '@xmldom/xmldom';

const exec=promisify(execFile);
// Official multi-platform manifest for Keycloak 26.8.2.
const image='quay.io/keycloak/keycloak@sha256:7e66a96e4739239070aeaf72e4c5decf0f7f682cfc725b9f7ea2b336eaba38b3';
const docker=(...args)=>exec('docker',args,{timeout:90000});
const metadataNs='urn:oasis:names:tc:SAML:2.0:metadata';

export async function verifyKeycloak({origin,dir,env,owner,employee,ownerId,employeeId,startWeb}){
  const client=origin+'/auth/saml/metadata',callback=origin+'/auth/saml/callback';
  const passwords=[randomBytes(24).toString('hex'),randomBytes(24).toString('hex')];
  const realm={realm:'harbor-trial',enabled:true,sslRequired:'none',clients:[{
    clientId:client,protocol:'saml',enabled:true,redirectUris:[callback],attributes:{
      'saml.authnstatement':'true','saml.server.signature':'true','saml.assertion.signature':'true','saml.client.signature':'false',
      'saml_name_id_format':'persistent','saml_force_name_id_format':'true','saml_assertion_consumer_url_post':callback,
    },
  }],users:[owner,employee].map((email,i)=>({username:email,email,emailVerified:true,firstName:'Fictional',lastName:i?'Employee':'Owner',
    enabled:true,attributes:{['saml.persistent.name.id.for.'+client]:[i?employeeId:ownerId]},
    credentials:[{type:'password',value:passwords[i],temporary:false}]}))};
  const files=join(dir,'realm-import'),file=join(files,'harbor-trial-realm.json');
  await mkdir(files);await writeFile(file,JSON.stringify(realm));
  // The containing temporary fixture directory is private; Keycloak reads the copied files as its own user.
  await chmod(files,0o755);await chmod(file,0o644);
  const name='harbor-saml-test-'+randomUUID();
  await docker('create','--name',name,'--publish','127.0.0.1::8080',image,'start-dev','--import-realm');
  let browser;
  try{
    await docker('cp',files,name+':/opt/keycloak/data/import');
    await docker('start',name);
    const published=(await docker('port',name,'8080/tcp')).stdout.trim();
    assert.match(published,/^127\.0\.0\.1:\d+$/);
    const issuer='http://'+published+'/realms/'+realm.realm;
    const entry=issuer+'/protocol/saml',descriptor=entry+'/descriptor';
    let xml;
    for(let i=0;i<180&&!xml;i++){
      const response=await fetch(descriptor,{signal:AbortSignal.timeout(1500)}).catch(()=>null);
      if(response?.ok)xml=await response.text();else await delay(400);
    }
    assert.ok(xml,'Keycloak did not publish realm metadata');
    const dom=new DOMParser().parseFromString(xml,'application/xml');
    const role=dom.getElementsByTagNameNS(metadataNs,'IDPSSODescriptor')[0];
    const signing=Array.from(role.getElementsByTagNameNS(metadataNs,'KeyDescriptor')).find(k=>k.getAttribute('use')==='signing');
    const certificate=signing.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#','X509Certificate')[0].textContent;
    Object.assign(env,{HARBOR_LOGIN_SAML_ISSUER:issuer,HARBOR_LOGIN_SAML_ENTRY_POINT:entry,
      HARBOR_LOGIN_SAML_CERT:new X509Certificate(Buffer.from(certificate,'base64')).toString()});
    const metadataFile=join(dir,'keycloak.xml');
    await writeFile(metadataFile,xml);
    const {stdout}=await exec(process.execPath,['scripts/portable-web.mjs','doctor','web','--saml-metadata',metadataFile],{env});
    assert.equal(JSON.parse(stdout).checks.samlMetadata,'ok');
    await startWeb();
    const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
    browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
    async function signIn(email,password,expectAccess=true){
      const page=await browser.newPage();
      await page.goto(origin+'/auth/sign-in?return_to='+encodeURIComponent('/?view=workspaces'));
      await page.getByText('Continue with company SSO',{exact:true}).click();
      await page.locator('#username').fill(email);await page.locator('#password').fill(password);
      await page.locator('#kc-login').click();
      await page.waitForURL(url=>url.origin===origin&&(url.pathname==='/'||url.searchParams.has('error')));
      const result=new URL(page.url());
      if(expectAccess)assert.equal(result.href,origin+'/?view=workspaces');
      else{
        assert.equal(result.pathname,'/auth/sign-in');
        assert.ok(result.searchParams.has('error'));
      }
      return page.context().request;
    }
    const ownerSession=await signIn(owner,passwords[0]);
    async function change(session,body){
      const response=await session.post(origin+'/api/workspaces',{headers:{origin},data:body});
      assert.equal(response.status(),200);return response.json();
    }
    const created=await ownerSession.post(origin+'/api/crm',{headers:{origin},data:{
      action:'save',kind:'contacts',data:{name:'Fictional Keycloak inquiry'},
    }});
    assert.equal(created.status(),201);
    const {record}=await created.json();
    const invited=await change(ownerSession,{action:'invite',email:employee,role:'editor'});
    const seat=invited.sent.find(row=>row.email===employee);assert.ok(seat);
    const rep=await signIn(employee,passwords[1]);
    const joined=await change(rep,{action:'accept_invite',id:seat.id});
    const grant=joined.shared.find(row=>row.id===invited.owned);assert.ok(grant);
    const path=origin+'/api/crm?'+new URLSearchParams({kind:'contacts',workspaceId:invited.owned,id:record.id});
    const visible=await rep.get(path);
    assert.equal(visible.status(),200);
    assert.equal((await visible.json()).data.name,record.data.name);
    await change(ownerSession,{action:'revoke',id:grant.grantId});
    assert.equal((await rep.get(origin+'/api/workspaces')).status(),401);
    assert.ok([401,403,404].includes((await rep.get(path)).status()));
    const fresh=await signIn(employee,passwords[1],false);
    assert.equal((await fresh.get(path)).status(),401);
    assert.equal((await (await ownerSession.get(origin+'/api/workspaces')).json()).owned,invited.owned);
    // Exercise the directory API independently of either browser's cookie jar.
    const issued=await ownerSession.post(origin+'/api/api-tokens',{headers:{origin},data:{
      name:'Fictional Keycloak directory',days:30,purpose:'saml_directory',
    }});
    assert.equal(issued.status(),201);
    const {token}=await issued.json();
    const directoryHeaders={authorization:'Bearer '+token,'content-type':'application/scim+json'};
    const users=origin+'/scim/v2/Users';
    const provisioned=await fetch(users,{method:'POST',headers:directoryHeaders,body:JSON.stringify({
      schemas:['urn:ietf:params:scim:schemas:core:2.0:User'],externalId:employeeId,userName:employee,active:true,roles:[{value:'viewer'}],
    })});
    assert.equal(provisioned.status,201);
    const membership=await provisioned.json();
    assert.deepEqual(membership.roles,[{value:'viewer'}]);
    const rehired=await signIn(employee,passwords[1]);
    const shared=await rehired.get(origin+'/api/workspaces');
    assert.equal(shared.status(),200);
    const current=(await shared.json()).shared.find(row=>row.id===invited.owned);
    assert.equal(current.role,'viewer');
    assert.notEqual(current.grantId,grant.grantId);
    assert.equal((await rehired.get(path)).status(),404);
    await change(ownerSession,{action:'record_scope',id:current.grantId,viewScope:'all',editScope:'owned'});
    const sharedInquiry=await rehired.get(path);
    assert.equal(sharedInquiry.status(),200);
    assert.equal((await sharedInquiry.json()).data.name,record.data.name);
    const deactivated=await fetch(users+'/'+membership.id,{method:'PATCH',headers:directoryHeaders,body:JSON.stringify({
      schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',path:'active',value:false}],
    })});
    assert.equal(deactivated.status,200);
    assert.equal((await deactivated.json()).active,false);
    assert.equal((await rehired.get(path)).status(),401);
    const departed=await signIn(employee,passwords[1],false);
    assert.equal((await departed.get(path)).status(),401);
    assert.equal((await (await ownerSession.get(origin+'/api/workspaces')).json()).owned,invited.owned);
  }finally{
    try{await browser?.close();}finally{await docker('rm','--force','--volumes',name);}
  }
}
