import type {ConnectionActor} from '../db/postgres/portable-connection-store';
import {ApiError} from '../lib/api-error';
import {requestIdentity,requestSessionHash} from './portable-identity';

export async function personalConnectionActor(request:Request,user:{userId:string;email:string}):Promise<ConnectionActor>{
  const sessionHash=await requestSessionHash(request.headers);
  if(!sessionHash)throw new ApiError(401,'Sign in again to manage this connection.');
  return {userId:user.userId,email:user.email,sessionHash};
}

export async function assertConnectionSession(request:Request,actor:ConnectionActor){
  const current=await requestIdentity(request.headers);
  if(current?.userId!==actor.userId||current.email!==actor.email||await requestSessionHash(request.headers)!==actor.sessionHash)
    throw new ApiError(401,'Sign in again to use this connection.');
}
