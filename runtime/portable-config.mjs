import {isIP} from 'node:net';

export const portableMaintenanceLock=943157310;
export const portableBackupMaxAgeHours=30;

export function portableMode(env){
  const mode=env.HARBOR_PORTABLE_MODE||'local';
  if(mode!=='local'&&mode!=='hosted')throw Error('HARBOR_PORTABLE_MODE must be local or hosted.');
  return mode;
}

const loopback=host=>['127.0.0.1','localhost','[::1]'].includes(host);

export function portableDatabaseUrl(env,mode){
  const url=URL.parse(env.DATABASE_URL??'');
  if(!url||!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.pathname.slice(1)||url.hash||
    (mode==='local'&&(!loopback(url.hostname)||url.search))){
    throw Error('Set a valid DATABASE_URL for the selected Harbor mode.');
  }
  return url;
}

const dnsLabel=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function portableStorageEndpoint(env,mode){
  const addressing=env.HARBOR_S3_ADDRESSING??'path-style';
  if(addressing!=='path-style'&&addressing!=='virtual-hosted'){
    throw Error('HARBOR_S3_ADDRESSING must be path-style or virtual-hosted.');
  }
  const url=URL.parse(env.HARBOR_S3_ENDPOINT??'');
  if(!url||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    (mode==='local'&&!loopback(url.hostname))||(mode==='hosted'&&url.protocol!=='https:')){
    throw Error('Set a valid S3 endpoint for the selected Harbor mode.');
  }
  if(addressing==='virtual-hosted'){
    const {hostname}=url,bucket=env.HARBOR_S3_BUCKET??'',labels=hostname.split('.');
    // Avoid SDK fallback for dotted buckets and IP endpoints, and implicit S3 Express sessions.
    if(mode!=='hosted'||bucket.length<3||!dnsLabel.test(bucket)||/--xa?-s3$/.test(bucket)||labels.length<2||isIP(hostname)||
      labels.at(-1)==='localhost'||labels.some(label=>!dnsLabel.test(label))||
      hostname.startsWith(bucket+'.')||bucket.length+1+hostname.length>253){
      throw Error('Virtual-hosted S3 requires hosted mode, a DNS base endpoint and a standard single-label bucket name.');
    }
  }
  return url;
}

export function portableStorageClientAddress(env,mode){
  const endpoint=portableStorageEndpoint(env,mode);
  return {endpoint:endpoint.href,forcePathStyle:env.HARBOR_S3_ADDRESSING!=='virtual-hosted'};
}

export function portableWebAddress(env,mode){
  const port=Number(env.PORT??8787),origin=URL.parse(env.HARBOR_LOGIN_ORIGIN??'');
  if(!Number.isInteger(port)||port<1||port>65535||!origin||origin.origin!==env.HARBOR_LOGIN_ORIGIN||
    (mode==='local'&&origin.origin!==`http://127.0.0.1:${port}`)||(mode==='hosted'&&origin.protocol!=='https:')){
    throw Error('Set PORT and the exact Harbor origin for the selected mode.');
  }
  return {origin,port,host:mode==='hosted'?'::':'127.0.0.1'};
}
