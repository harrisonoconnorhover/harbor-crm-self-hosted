import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';

// Optional independent protocol implementation, supplied by the local test operator.
export async function verifyOidcBrowser({origin,env,startWeb}){
  const {Provider}=await import(process.env.HARBOR_TEST_OIDC_PROVIDER);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const server=createServer().listen(0,'127.0.0.1');
  await once(server,'listening');
  let browser;
  try{
    const issuer='http://127.0.0.1:'+server.address().port;
    const clientId='harbor-browser',secret=randomBytes(32).toString('hex');
    const owner='oidc-browser-owner@example.test',employee='oidc-browser-rep@example.test';
    const provider=new Provider(issuer,{clients:[{client_id:clientId,client_secret:secret,
      redirect_uris:[origin+'/auth/oidc/callback'],response_types:['code'],grant_types:['authorization_code']}],
      cookies:{keys:[randomBytes(32).toString('hex')]}});
    server.on('request',provider.callback());
    Object.assign(env,{HARBOR_LOGIN_OIDC_ISSUER:issuer,HARBOR_LOGIN_OIDC_CLIENT_ID:clientId,
      HARBOR_LOGIN_OIDC_CLIENT_SECRET:secret,HARBOR_LOGIN_OIDC_BINDINGS:JSON.stringify({operator:owner,teammate:employee}),
      HARBOR_LOGIN_ALLOWED_EMAILS:owner});
    await startWeb();
    browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
    async function signIn(subject){
      const page=await browser.newPage();
      const destination='/?view=workspaces';
      await page.goto(origin+'/auth/sign-in?return_to='+encodeURIComponent(destination));
      await page.getByRole('link',{name:'Continue with company OpenID Connect'}).click();
      await page.getByPlaceholder('Enter any login').fill(subject);
      await page.getByPlaceholder('and password').fill('local-fictional-account');
      await page.getByRole('button',{name:'Sign-in',exact:true}).click();
      await page.getByRole('button',{name:'Continue',exact:true}).click();
      await page.waitForURL(origin+destination);
      return page.context().request;
    }
    async function post(session,path,data){
      const response=await session.post(origin+path,{headers:{origin},data});
      assert.ok(response.ok(),await response.text());
      return response.json();
    }
    const operator=await signIn('operator');
    const {record}=await post(operator,'/api/crm',{action:'save',kind:'contacts',data:{name:'Fictional OIDC browser inquiry'}});
    const invite=await post(operator,'/api/workspaces',{action:'invite',email:employee,role:'viewer'});
    const rep=await signIn('teammate');
    const joined=await post(rep,'/api/workspaces',{action:'accept_invite',id:invite.sent.find(person=>person.email===employee).id});
    const grant=joined.shared.find(row=>row.id===invite.owned);
    const path=origin+'/api/crm?'+new URLSearchParams({workspaceId:invite.owned,kind:'contacts',id:record.id});
    assert.equal((await (await rep.get(path)).json()).data.name,record.data.name);
    await post(operator,'/api/workspaces',{action:'revoke',id:grant.grantId});
    assert.equal((await rep.get(path)).status(),401);
    env.HARBOR_OIDC_DIRECTORY_AUTHORITY_WORKSPACE_ID=invite.owned;
    env.HARBOR_OIDC_DIRECTORY_EMAIL_DOMAIN='directory.example.test';
    await startWeb();
    const {token}=await post(operator,'/api/api-tokens',{name:'Browser directory rehearsal',days:30,purpose:'oidc_directory'});
    const headers={authorization:'Bearer '+token,'content-type':'application/scim+json'};
    const newHire={schemas:['urn:ietf:params:scim:schemas:core:2.0:User'],externalId:'new-hire',userName:'new-hire@directory.example.test',active:true,roles:[{value:'editor'}]};
    const directoryUrl=origin+'/scim/v2/Users';
    const response=await operator.post(directoryUrl,{headers,data:newHire});
    assert.equal(response.status(),201,await response.text());
    const {id}=await response.json();
    const provisioned=await signIn('new-hire');
    const access=(await (await provisioned.get(origin+'/api/workspaces')).json()).shared.find(row=>row.id===invite.owned);
    const own=await post(provisioned,'/api/crm?'+new URLSearchParams({workspaceId:invite.owned,grantId:access.grantId}),
      {action:'save',kind:'contacts',data:{name:'Directory rep browser inquiry'}});
    const saved=origin+'/api/crm?'+new URLSearchParams({workspaceId:invite.owned,kind:'contacts',id:own.record.id});
    assert.equal((await (await provisioned.get(saved)).json()).data.name,'Directory rep browser inquiry');
    assert.equal((await provisioned.get(path)).status(),404);
    const removed=await operator.put(directoryUrl+'/'+id,{headers,data:{...newHire,active:false}});
    assert.equal(removed.status(),200,await removed.text());
    assert.equal((await provisioned.get(saved)).status(),401);
    assert.ok((await operator.get(origin+'/api/workspaces')).ok());
  }finally{
    await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
