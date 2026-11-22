import assert from 'node:assert/strict';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {exportJWK,generateKeyPair,SignJWT} from 'jose';

export async function verifyCompanyOidc({origin,env,startWeb,request,expectReturn,disabled,checked,get,json,existingEmail}){
  const owner='oidc-owner@example.test',employee='oidc-staff@example.test',returnTo='/?view=workspaces';
  const client='fictional-harbor',secret='local-client:secret',codes=new Map();
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const jwk={...await exportJWK(publicKey),kid:'local-1',alg:'RS256'};
  let issuer,serverError,incorrectMetadata=false;
  const server=createServer(async(req,res)=>{
    try{
      res.setHeader('content-type','application/json');
      if(req.url==='/tenant/.well-known/openid-configuration'){
        res.end(JSON.stringify({issuer:incorrectMetadata?issuer+'/mismatch':issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/keys'}));return;
      }
      if(req.url==='/tenant/keys'){res.end(JSON.stringify({keys:[jwk]}));return;}
      assert.equal(req.url,'/tenant/token');
      assert.equal(req.method,'POST');
      assert.equal(req.headers.authorization,'Basic '+Buffer.from(client+':local-client%3Asecret').toString('base64'));
      let input='';for await(const chunk of req)input+=chunk;
      const body=new URLSearchParams(input),attempt=codes.get(body.get('code'));
      assert.ok(attempt);codes.delete(body.get('code'));
      assert.equal(body.get('redirect_uri'),origin+'/auth/oidc/callback');
      assert.equal(body.get('grant_type'),'authorization_code');
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),attempt.challenge);
      const token=await new SignJWT({sub:attempt.sub,iss:issuer,aud:client,nonce:attempt.nonce,
        email:existingEmail,name:'Fictional employee',...attempt.overrides})
        .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuedAt().setExpirationTime('5m').sign(privateKey);
      res.end(JSON.stringify({id_token:token}));
    }catch(error){serverError=error;res.statusCode=400;res.end('{}');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  issuer='http://127.0.0.1:'+server.address().port+'/tenant';
  try{
    const samlSettings=Object.fromEntries(Object.entries(env).filter(([key])=>key.startsWith('HARBOR_LOGIN_SAML_')));
    for(const key of Object.keys(env)){
      if(/^HARBOR_(LOGIN_(SAML|MICROSOFT|GOOGLE)_|DIRECTORY_|SAML_DIRECTORY_)/.test(key))delete env[key];
    }
    const bindings={Operator:owner,Employee:employee,Collision:existingEmail};
    Object.assign(env,{HARBOR_LOGIN_OIDC_ISSUER:issuer,HARBOR_LOGIN_OIDC_CLIENT_ID:client,HARBOR_LOGIN_OIDC_CLIENT_SECRET:secret,
      HARBOR_LOGIN_ALLOWED_EMAILS:owner+','+existingEmail,HARBOR_LOGIN_OIDC_BINDINGS:JSON.stringify(bindings)});
    const {stdout}=await promisify(execFile)(process.execPath,['scripts/portable-web.mjs','doctor','web'],{env});
    const report=JSON.parse(stdout);
    assert.equal(report.result,'ready');assert.equal(report.checks.oidcSignIn,'ok');
    assert.equal(report.oidcCallbackUrl,origin+'/auth/oidc/callback');assert.ok(!stdout.includes(secret));
    await startWeb();
    const login=await request('/auth/sign-in');
    assert.match(await login.text(),/Continue with company OpenID Connect/);
    async function signIn(sub,overrides={}){
      const start=await request('/auth/oidc/start?return_to='+encodeURIComponent(returnTo));
      assert.equal(start.status,303);
      const url=new URL(start.headers.get('location')),params=url.searchParams;
      assert.equal(url.origin+url.pathname,issuer+'/authorize');
      assert.equal(params.get('scope'),'openid profile');
      assert.equal(params.get('code_challenge_method'),'S256');
      const code=randomUUID();
      codes.set(code,{sub,nonce:params.get('nonce'),challenge:params.get('code_challenge'),overrides});
      const result=await request('/auth/oidc/callback?'+new URLSearchParams({code,state:params.get('state')}),
        {headers:{cookie:start.headers.getSetCookie()[0].split(';')[0]}});
      if(serverError)throw serverError;
      return result;
    }
    const ownerCookie=expectReturn(await signIn('Operator'));
    const created=await checked(json('/api/crm',ownerCookie,{action:'save',kind:'contacts',data:{name:'Fictional OIDC inquiry'}}),201);
    const state=await checked(get('/api/workspaces',ownerCookie));assert.ok(state.owned);
    disabled(await signIn('operator'));disabled(await signIn('Operator',{nonce:'unrelated'}));
    disabled(await signIn('Operator',{aud:'other-client'}));disabled(await signIn('Operator',{iss:issuer+'/other'}));
    disabled(await signIn('Operator',{azp:'other-client'}));disabled(await signIn('Collision'));
    disabled(await signIn('Employee'));
    const invited=await checked(json('/api/workspaces',ownerCookie,{action:'invite',role:'viewer',email:employee}));
    const memberCookie=expectReturn(await signIn('Employee'));
    const membership=await checked(json('/api/workspaces',memberCookie,{action:'accept_invite',id:invited.sent.find(row=>row.email===employee).id}));
    const grant=membership.shared.find(row=>row.id===state.owned);
    assert.equal(grant.role,'viewer');
    const recordPath='/api/crm?'+new URLSearchParams({workspaceId:state.owned,kind:'contacts',id:created.record.id});
    assert.equal((await checked(get(recordPath,memberCookie))).data.name,created.record.data.name);
    await checked(json('/api/workspaces',ownerCookie,{action:'revoke',id:grant.grantId}));
    assert.equal((await get('/api/workspaces',memberCookie)).status,401);
    assert.equal((await get(recordPath,memberCookie)).status,401);
    disabled(await signIn('Employee'));
    const subject='Division:Sales/Casey-01',email='oidc-casey@fictional-directory.example';
    Object.assign(env,samlSettings,{HARBOR_LOGIN_SAML_ISSUER:issuer,
      HARBOR_OIDC_DIRECTORY_AUTHORITY_WORKSPACE_ID:state.owned,HARBOR_OIDC_DIRECTORY_EMAIL_DOMAIN:'fictional-directory.example'});
    await startWeb();
    const doctor=await promisify(execFile)(process.execPath,['scripts/portable-web.mjs','doctor','web','--check-workspace-access'],{env});
    assert.equal(JSON.parse(doctor.stdout).checks.oidcDirectoryAuthority,'ok');
    const token=async purpose=>(await checked(json('/api/api-tokens',ownerCookie,{name:'Fictional directory',days:30,purpose}),201)).token;
    const oidc=await token('oidc_directory'),saml=await token('saml_directory');
    const scim=(credential,path,method='GET',body)=>request('/scim/v2/'+path,{method,
      headers:{authorization:'Bearer '+credential,'content-type':'application/scim+json'},...(body?{body:JSON.stringify(body)}:{})});
    const core='urn:ietf:params:scim:schemas:core:2.0:',user={schemas:[core+'User'],externalId:subject,userName:email,active:true,roles:[{value:'editor'}]};
    await checked(scim(oidc,'Users','POST',{...user,userName:'casey@outside.example'}),400);
    await checked(scim(oidc,'Users','POST',{...user,userName:owner}),400);
    await checked(scim(oidc,'Users','POST',{...user,userName:'casey@fictional-directory.example'}),409);
    const hire=await checked(scim(oidc,'Users','POST',user),201);
    const lookup='Users?filter='+encodeURIComponent('externalId eq "'+subject+'"');
    assert.equal((await checked(scim(oidc,lookup))).totalResults,1);
    assert.equal((await checked(scim(saml,lookup))).totalResults,0);
    await checked(scim(saml,'Users/'+hire.id),404);
    const team=randomUUID(),group={schemas:[core+'Group'],displayName:'Sales',externalId:'Sales-01',members:[{value:hire.id}]};
    await checked(json('/api/workspaces',ownerCookie,{action:'team_create',id:team,name:'Fictional sales team',parentId:null}));
    await checked(json('/api/workspaces',ownerCookie,{action:'oidc_group_map',teamId:team,groupName:group.displayName,expectedExternalId:group.externalId}));
    const linked=await checked(scim(oidc,'Groups','POST',group),201);
    await checked(scim(saml,'Groups/'+linked.id),404);
    const employeeState=await checked(scim(oidc,'Users/'+hire.id));
    assert.equal(employeeState.groups[0].value,linked.id);
    const rep=expectReturn(await signIn(subject));
    const shared=(await checked(get('/api/workspaces',rep))).shared.find(row=>row.id===state.owned);
    assert.equal(shared.role,'editor');
    assert.equal((await checked(get('/api/workspaces',ownerCookie))).viewers.find(row=>row.email===email).teamId,team);
    const createContact=grantId=>json('/api/crm?'+new URLSearchParams({workspaceId:state.owned,grantId}),rep,
      {action:'save',kind:'contacts',data:{name:'Directory-provisioned inquiry'}});
    const own=await checked(createContact(shared.grantId),201);
    const ownedPath='/api/crm?'+new URLSearchParams({workspaceId:state.owned,kind:'contacts',id:own.record.id});
    assert.equal((await get(recordPath,rep)).status,404);
    await checked(scim(oidc,'Users/'+hire.id,'PUT',{...user,roles:[{value:'viewer'}]}));
    const viewer=(await checked(get('/api/workspaces',rep))).shared.find(row=>row.id===state.owned);
    assert.equal(viewer.role,'viewer');
    assert.ok([403,404].includes((await createContact(viewer.grantId)).status));
    assert.equal((await get(ownedPath,rep)).status,200);
    await checked(scim(oidc,'Users/'+hire.id,'PUT',{...user,active:false}));
    assert.equal((await get(ownedPath,rep)).status,401);
    disabled(await signIn(subject));
    const employeeOnly={...env,HARBOR_LOGIN_OIDC_BINDINGS:'{}',
      HARBOR_LOGIN_SAML_BINDINGS:JSON.stringify({LocalOperator:owner})};
    const separateOwner=await promisify(execFile)(process.execPath,['scripts/portable-web.mjs','doctor','web'],{env:employeeOnly});
    assert.equal(JSON.parse(separateOwner.stdout).checks.oidcDirectoryAuthority,'ok');
    delete bindings.Operator;
    env.HARBOR_LOGIN_OIDC_BINDINGS=JSON.stringify(bindings);
    await startWeb();
    assert.equal((await get('/api/workspaces',ownerCookie)).status,401);
    disabled(await signIn('Operator'));
    incorrectMetadata=true;
    await startWeb();
    const failure=await request('/auth/oidc/start');
    assert.equal(failure.status,303);
    assert.equal(new URL(failure.headers.get('location')).pathname,'/auth/sign-in');
    assert.match(failure.headers.get('cache-control'),/no-store/);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
