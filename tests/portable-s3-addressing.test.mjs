import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import test from 'node:test';
import {GetObjectCommand,HeadBucketCommand,ListObjectsV2Command,PutObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {portableStorageClientAddress} from '../runtime/portable-config.mjs';

const bucket='harbor-private';
const endpoint='https://storage.example.test';
const env={HARBOR_S3_ENDPOINT:endpoint,HARBOR_S3_BUCKET:bucket};
const key='contact-files/example';

test('the S3 SDK signs virtual-hosted requests without a bucket path prefix', async t=>{
  const requests=[];
  const address=portableStorageClientAddress({...env,HARBOR_S3_ADDRESSING:'virtual-hosted'},'hosted');
  const client=new S3Client({...address,region:'us-east-1',credentials:{
    accessKeyId:'fictional-access-key',secretAccessKey:'fictional-secret-key',
  },requestHandler:{async handle(request){
    requests.push(request);
    const body=request.query?.['list-type']?'<?xml version="1.0"?><ListBucketResult></ListBucketResult>':'';
    return {response:{statusCode:200,headers:{},body:Readable.from([body])}};
  }}});
  t.after(()=>client.destroy());
  await client.send(new HeadBucketCommand({Bucket:bucket}));
  await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:'data',IfNoneMatch:'*'}));
  const read=await client.send(new GetObjectCommand({Bucket:bucket,Key:key}));
  await read.Body.transformToString();
  await client.send(new ListObjectsV2Command({Bucket:bucket,MaxKeys:1}));
  assert.deepEqual(requests.map(({method,path})=>[method,path]),[['HEAD','/'],['PUT','/'+key],['GET','/'+key],['GET','/']]);
  for(const request of requests){
    assert.equal(request.protocol,'https:');
    assert.equal(request.hostname,bucket+'.storage.example.test');
    assert.equal(request.headers.host,request.hostname);
    assert.match(request.headers.authorization,/^AWS4-HMAC-SHA256 Credential=fictional-access-key\//);
    assert.match(request.headers.authorization,/SignedHeaders=[^,]*\bhost\b/);
  }
  assert.equal(requests[1].headers['if-none-match'],'*');
  assert.equal(requests[3].query['list-type'],'2');
});

test('default and explicit path-style keep the signed bucket path', async t=>{
  const address=portableStorageClientAddress({...env,HARBOR_S3_ENDPOINT:'http://127.0.0.1:9000'},'local');
  assert.deepEqual(address,{endpoint:'http://127.0.0.1:9000/',forcePathStyle:true});
  assert.deepEqual(portableStorageClientAddress({...env,HARBOR_S3_ADDRESSING:'path-style'},'hosted'),
    {endpoint:endpoint+'/',forcePathStyle:true});
  const requests=[];
  const client=new S3Client({...address,region:'us-east-1',credentials:{
    accessKeyId:'fictional-access-key',secretAccessKey:'fictional-secret-key',
  },requestHandler:{async handle(request){
    requests.push(request);
    return {response:{statusCode:200,headers:{}}};
  }}});
  t.after(()=>client.destroy());
  await client.send(new HeadBucketCommand({Bucket:bucket}));
  assert.equal(requests[0].hostname,'127.0.0.1');
  assert.equal(requests[0].path,'/'+bucket+'/');
  assert.match(requests[0].headers.authorization,/^AWS4-HMAC-SHA256 /);
});

test('invalid addressing and targets fail closed before S3 can fall back', ()=>{
  for(const value of ['','virtual','Path-style']){
    assert.throws(()=>portableStorageClientAddress({...env,HARBOR_S3_ADDRESSING:value},'hosted'),/HARBOR_S3_ADDRESSING/);
  }
  const virtual={...env,HARBOR_S3_ADDRESSING:'virtual-hosted'};
  for(const host of ['127.0.0.1','[::1]','localhost','object.localhost','bad_label.example.test',bucket+'.storage.example.test']){
    assert.throws(()=>portableStorageClientAddress({...virtual,HARBOR_S3_ENDPOINT:'https://'+host},'hosted'),/Virtual-hosted S3/);
  }
  for(const name of ['','ab','dotted.bucket','Bad','bad-','express--x-s3','express--xa-s3','x'.repeat(64)]){
    assert.throws(()=>portableStorageClientAddress({...virtual,HARBOR_S3_BUCKET:name},'hosted'),/Virtual-hosted S3/);
  }
  assert.throws(()=>portableStorageClientAddress({...virtual,HARBOR_S3_ENDPOINT:'https://localhost:9000'},'local'),/Virtual-hosted S3/);
  assert.throws(()=>portableStorageClientAddress({...virtual,HARBOR_S3_ENDPOINT:'http://storage.example.test'},'hosted'),/valid S3 endpoint/);
  assert.throws(()=>portableStorageClientAddress(env,'local'),/valid S3 endpoint/);
});
