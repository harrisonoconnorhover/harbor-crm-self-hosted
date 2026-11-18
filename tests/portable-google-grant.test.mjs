import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';

const command=fileURLToPath(new URL('../scripts/portable-web.mjs',import.meta.url));
const origin='http://127.0.0.1:8775';
const redirectUri=origin+'/google-grant/callback';
const owner='fixture-owner@example.test';
const clientSecret='fictional-grant-client-secret';
const accessToken='fictional-grant-access';
const refreshToken='1//fictional-portable-refresh';
const authCode='fictional-grant-code';
const scopes={
  gmail:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'],
  calendar:['https://www.googleapis.com/auth/calendar.freebusy','https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/calendar.events.owned'],
};

function providerStub(settings){
  return 'data:text/javascript,'+encodeURIComponent(`
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    import {appendFileSync,existsSync,readFileSync} from 'node:fs';
    import {setTimeout as delay} from 'node:timers/promises';
    const f=${JSON.stringify(settings)};
    globalThis.fetch=async (input, init)=>{
      const url=new URL(input);
      appendFileSync(f.calls,JSON.stringify(url.href)+'\\n');
      if(url.href==='https://oauth2.googleapis.com/token'){
        assert.equal(init.method,'POST');
        assert.equal(init.redirect,'manual');
        const body=new URLSearchParams(init.body);
        assert.equal(body.get('grant_type'),'authorization_code');
        assert.equal(body.get('client_id'),f.clientId);
        assert.equal(body.get('client_secret'),f.clientSecret);
        assert.equal(body.get('code'),f.authCode);
        assert.equal(body.get('redirect_uri'),f.redirectUri);
        const verifier=body.get('code_verifier');
        assert.match(verifier,/^[A-Za-z0-9_-]{43}$/);
        assert.equal(createHash('sha256').update(verifier).digest('base64url'),readFileSync(f.challenge,'utf8'));
        while(f.resume&&!existsSync(f.resume))await delay(10);
        return Response.json({access_token:f.accessToken,refresh_token:f.refreshToken,expires_in:3600,
          token_type:'Bearer',scope:f.scope.join(' ')});
      }
      assert.equal(url.href,f.profile);
      assert.equal(init.method??'GET','GET');
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+f.accessToken);
      return Response.json(f.provider==='gmail'?{emailAddress:f.email}:{id:'fixture-owner',email:f.email,verified_email:true});
    };
  `);
}

async function runGrant(provider,{wrongOwner=false,missingScope=false,existingDestination=false,checkCallback=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'harbor-google-grant-'));
  const output=join(dir,'grant.env'),calls=join(dir,'calls'),challenge=join(dir,'challenge');
  const resume=checkCallback?join(dir,'resume'):undefined;
  const clientId=provider+'-portable-grant-fixture.apps.googleusercontent.com';
  const prefix='HARBOR_PORTABLE_'+provider.toUpperCase();
  const profile=provider==='gmail'?'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress':
    'https://www.googleapis.com/oauth2/v2/userinfo';
  await writeFile(calls,'');
  const mock=providerStub({provider,clientId,clientSecret,accessToken,refreshToken,authCode,redirectUri,profile,calls,challenge,resume,
    email:wrongOwner?'unexpected-account@example.test':owner,scope:missingScope?scopes[provider].slice(0,-1):scopes[provider]});
  const child=spawn(process.execPath,['--import',mock,command,'google-grant',provider,output],{
    env:{[prefix+'_OWNER']:owner.toUpperCase(),[prefix+'_CLIENT_ID']:clientId,[prefix+'_CLIENT_SECRET']:clientSecret,
      HARBOR_PORTABLE_GMAIL_ENABLED:'false',HARBOR_PORTABLE_CALENDAR_ENABLED:'false'},
    stdio:['ignore','pipe','pipe'],
  });
  let logs='',result;
  for(const stream of [child.stdout,child.stderr])stream.setEncoding('utf8').on('data',chunk=>{logs+=chunk;});
  const closed=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>{result={code,signal};resolve(result);});
  });
  const request=url=>fetch(url,{redirect:'manual',signal:AbortSignal.timeout(4000)});
  const called=async()=>String(await readFile(calls)).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  try{
    let entry;
    const deadline=Date.now()+6000;
    while(!entry&&Date.now()<deadline){
      if(result)assert.fail('Google grant command exited before listening: '+logs);
      entry=await request(origin+'/').catch(()=>null);
      if(!entry)await delay(20);
    }
    assert.ok(entry,'Google grant command did not start its loopback listener.');
    assert.ok(entry.status>=300&&entry.status<400);
    const authorization=new URL(entry.headers.get('location'));
    await entry.body?.cancel();
    assert.equal(authorization.origin+authorization.pathname,'https://accounts.google.com/o/oauth2/v2/auth');
    const auth=authorization.searchParams, state=auth.get('state');
    assert.match(state,/^[A-Za-z0-9_-]{43}$/);
    assert.match(auth.get('code_challenge'),/^[A-Za-z0-9_-]{43}$/);
    assert.equal(auth.get('code_challenge_method'),'S256');
    assert.equal(auth.get('access_type'),'offline');
    assert.equal(auth.get('response_type'),'code');
    assert.equal(auth.get('client_id'),clientId);
    assert.equal(auth.get('redirect_uri'),redirectUri);
    assert.deepEqual(auth.get('scope').split(/\s+/).sort(),[...scopes[provider]].sort());
    assert.ok(!authorization.href.includes(clientSecret));
    await writeFile(challenge,auth.get('code_challenge'));

    const callback=checkState=>{
      const url=new URL(redirectUri);
      url.search=new URLSearchParams({state:checkState,code:authCode}).toString();
      return request(url);
    };
    if(checkCallback){
      const rejected=await callback('fictional-invalid-state');
      assert.ok(rejected.status>=400&&rejected.status<500);
      await rejected.body?.cancel();
      assert.deepEqual(await called(),[]);
      await assert.rejects(stat(output),{code:'ENOENT'});
    }
    if(existingDestination)await writeFile(output,'existing fixture\n',{mode:0o600});
    const completing=callback(state);
    void completing.catch(()=>{});
    if(resume){
      const deadline=Date.now()+3000;
      while(!(await called()).length&&Date.now()<deadline)await delay(10);
      assert.equal((await called()).length,1);
      const replay=await callback(state);
      assert.equal(replay.status,409);
      await replay.body?.cancel();
      await writeFile(resume,'');
    }
    const response=await completing;
    const reply=await response.text();
    const done=await Promise.race([closed,delay(4000,null,{ref:false})]);
    assert.ok(done,'Google grant command did not close its loopback listener.');
    assert.equal(done.signal,null);
    for(const secret of [clientSecret,accessToken,refreshToken,authCode,state]){
      assert.ok(!logs.includes(secret),'A credential was written to the terminal.');
      assert.ok(!reply.includes(secret),'A credential was written to the browser response.');
    }
    const tokenCall='https://oauth2.googleapis.com/token';
    if(existingDestination){
      assert.notEqual(done.code,0);
      assert.equal(await readFile(output,'utf8'),'existing fixture\n');
      const seen=await called();
      // The CLI may detect the conflict before or after verifying the returned grant.
      if(seen.length)assert.deepEqual(seen,[tokenCall,profile]);
    }else if(wrongOwner||missingScope){
      assert.notEqual(done.code,0);
      await assert.rejects(stat(output),{code:'ENOENT'});
      assert.deepEqual(await called(),missingScope?[tokenCall]:[tokenCall,profile]);
    }else{
      assert.equal(done.code,0,logs);
      assert.ok(response.ok);
      assert.deepEqual(await called(),[tokenCall,profile]);
      assert.deepEqual({...parseEnv(await readFile(output,'utf8'))},{[prefix+'_REFRESH_TOKEN']:refreshToken});
      assert.equal((await stat(output)).mode&0o777,0o600);
    }
  }finally{
    if(!result)child.kill('SIGKILL');
    try{await closed;}finally{await rm(dir,{force:true,recursive:true});}
  }
}

test('local Gmail setup exchanges the one-use PKCE callback for only the owner refresh token',()=>runGrant('gmail',{checkCallback:true}));
test('local Calendar setup requests availability, owner identity and owned event scopes',()=>runGrant('calendar'));
test('local setup refuses a Gmail grant belonging to another account',()=>runGrant('gmail',{wrongOwner:true}));
test('local setup refuses a Calendar grant missing its event scope',()=>runGrant('calendar',{missingScope:true}));
test('local setup preserves an output file created during consent',()=>runGrant('gmail',{existingDestination:true}));
