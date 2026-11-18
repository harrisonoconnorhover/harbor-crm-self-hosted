// Loaded only in the child process serving this loopback acceptance test.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {outlookConnectionFetch} from './portable-outlook-connection-fixture.mjs';
import {outlookRecordsFetch} from './portable-outlook-records-fixture.mjs';

const original=globalThis.fetch;
globalThis.fetch=async(input,options)=>{
  const url=new URL(input),origin=process.env.HARBOR_LOGIN_ORIGIN;
  if(url.origin===origin)return original(input,options);
  const outlook=await outlookConnectionFetch(url,options)??await outlookRecordsFetch(url,options);
  if(outlook)return outlook;
  const microsoft=url.origin==='https://login.microsoftonline.com';
  const fixture=JSON.parse(await readFile(process.env.HARBOR_TEST_MICROSOFT_IDENTITY_FIXTURE,'utf8'));
  const tenant=process.env.HARBOR_LOGIN_MICROSOFT_TENANT_ID;
  const prefix='https://login.microsoftonline.com/'+(tenant==='9188040d-6c67-4c5b-b112-36a304b66dad'?'consumers':tenant);
  if(url.href===prefix+'/discovery/v2.0/keys'||url.href==='https://www.googleapis.com/oauth2/v3/certs'){
    assert.equal(options.redirect,'manual');
    return Response.json({keys:[fixture.keys[microsoft?'microsoft':'google']]});
  }
  assert.equal(url.href,microsoft?prefix+'/oauth2/v2.0/token':'https://oauth2.googleapis.com/token');
  assert.equal(options.method,'POST');
  assert.equal(options.redirect,'manual');
  const {body}=options,provider=microsoft?'microsoft':'google';
  assert.equal(body.get('grant_type'),'authorization_code');
  assert.equal(body.get('code'),fixture.code);
  assert.equal(body.get('client_id'),process.env['HARBOR_LOGIN_'+provider.toUpperCase()+'_CLIENT_ID']);
  assert.equal(body.get('client_secret'),process.env['HARBOR_LOGIN_'+provider.toUpperCase()+'_CLIENT_SECRET']);
  assert.equal(body.get('redirect_uri'),origin+'/auth/'+provider+'/callback');
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),fixture.challenge);
  if(microsoft)assert.equal(body.get('scope'),'openid profile email');
  return Response.json({id_token:fixture.token});
};
