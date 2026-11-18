import {createHash} from 'node:crypto';
import {GetObjectCommand,HeadBucketCommand,HeadObjectCommand,ListObjectsV2Command,PutObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {attachmentBytes} from '../lib/activity-attachments';
import {portableMode,portableStorageClientAddress,portableStorageEndpoint} from './portable-config.mjs';

export function objectStorageConfigured(){
  return !!(process.env.HARBOR_S3_ENDPOINT&&process.env.HARBOR_S3_BUCKET&&process.env.HARBOR_S3_ACCESS_KEY_ID&&process.env.HARBOR_S3_SECRET_ACCESS_KEY);
}

let client:S3Client|undefined;
function storage(){
  if(!objectStorageConfigured())throw Error('Portable file storage is unavailable.');
  const address=portableStorageClientAddress(process.env,portableMode(process.env));
  client??=new S3Client({...address,region:process.env.HARBOR_S3_REGION||'us-east-1',
    credentials:{accessKeyId:process.env.HARBOR_S3_ACCESS_KEY_ID!,secretAccessKey:process.env.HARBOR_S3_SECRET_ACCESS_KEY!},
    maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  return {client,bucket:process.env.HARBOR_S3_BUCKET!};
}

export const fileDigest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

export async function readPrivateObject(key:string,expected:{size:number;sha256:string}){
  const {client,bucket}=storage();
  const output=await client.send(new GetObjectCommand({Bucket:bucket,Key:key}),{abortSignal:AbortSignal.timeout(10_000)});
  if(!output.Body)throw Error('Object bytes unavailable.');
  const bytes=await attachmentBytes(new Response(output.Body.transformToWebStream()));
  if(bytes.length!==expected.size||fileDigest(bytes)!==expected.sha256)throw Error('Stored file did not match its receipt.');
  return bytes;
}

function objectErrorStatus(error:unknown){
  if(error instanceof Error&&'$metadata' in error){
    return (error.$metadata as {httpStatusCode?:number}|undefined)?.httpStatusCode;
  }
}

const transientObjectCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','EAI_AGAIN']);
function transientObjectFailure(error:unknown){
  if(!(error instanceof Error))return false;
  const status=objectErrorStatus(error);
  if(status!==undefined)return status===429||(status>=500&&status<600)||error.name==='RequestTimeout';
  return error.name==='AbortError'||error.name==='TimeoutError'||
    ('code' in error&&typeof error.code==='string'&&transientObjectCodes.has(error.code));
}

export async function writePrivateObject(key:string,bytes:Uint8Array,sha256:string,{retryTransient=false}={}){
  const {client,bucket}=storage();
  for(let attempt=0;attempt<2;attempt++){
    let putFailure:unknown;
    try{
      await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:bytes,ContentLength:bytes.length,IfNoneMatch:'*'}),
        {abortSignal:AbortSignal.timeout(10_000)});
    }catch(error){
      // A timeout or rejected overwrite can mean this version already exists. Verify before publication.
      if(retryTransient&&objectErrorStatus(error)!==412&&!transientObjectFailure(error))throw error;
      putFailure=error;
    }
    try{
      await readPrivateObject(key,{size:bytes.length,sha256});
      return;
    }catch(error){
      if(!retryTransient||attempt===1)throw error;
      // A transient PUT that wrote nothing can surface as NoSuchKey on readback.
      const missingAfterTransientPut=error instanceof Error&&error.name==='NoSuchKey'&&transientObjectFailure(putFailure);
      if(!transientObjectFailure(error)&&!missingAfterTransientPut)throw error;
    }
  }
}

export async function objectBucketIsEmpty(){
  const {client,bucket}=storage();
  const result=await client.send(new ListObjectsV2Command({Bucket:bucket,MaxKeys:1}),{abortSignal:AbortSignal.timeout(10_000)});
  return !result.Contents?.length&&!result.IsTruncated;
}

export async function assertObjectStorageAvailable(){
  const {client,bucket}=storage();
  await client.send(new HeadBucketCommand({Bucket:bucket}),{abortSignal:AbortSignal.timeout(3000)});
}

export async function privateObjectSize(key:string){
  const {client,bucket}=storage();
  const object=await client.send(new HeadObjectCommand({Bucket:bucket,Key:key}),{abortSignal:AbortSignal.timeout(3000)});
  return object.ContentLength;
}

export async function checkFilePrivacy(key:string){
  const {bucket}=storage();
  const mode=portableMode(process.env);
  const object=portableStorageEndpoint(process.env,mode);
  if(process.env.HARBOR_S3_ADDRESSING==='virtual-hosted'){
    object.hostname=bucket+'.'+object.hostname;
    object.pathname='/'+key;
  }else{
    if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))return 'invalid_bucket_for_privacy_check';
    object.pathname='/'+bucket+'/'+key;
  }
  try{
    if(!await privateObjectSize(key))return 'file_fixture_unavailable';
  }catch{return 'file_fixture_unavailable';}
  try{
    const response=await fetch(object,{method:'GET',headers:{range:'bytes=0-0'},
      redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(3000)});
    void response.body?.cancel().catch(()=>{});
    if(response.status===401||response.status===403)return 'ok';
    return response.ok?'public_file_readable':'file_privacy_unverified';
  }catch{return 'file_privacy_unverified';}
}
