import type {BudgetScope} from '../db/postgres/rate-limit-schema';
import {admitLoginCallback,consumeBudget} from '../db/postgres/rate-limit-store';
import {sha256} from '../lib/email/crypto';
import {GoogleLoginAdmissionError} from '../lib/identity-service';
import {portableDb} from './portable-db';

const limits={login_start:30,login_callback:60,api_read:120,api_write:60,public_form:45} satisfies Record<BudgetScope,number>;
const failure=(status:number,error:string)=>Response.json({error},{status,headers:{
  'cache-control':'private, no-store','retry-after':'60','referrer-policy':'no-referrer',
}});

const limited=()=>failure(429,'Too many requests. Please wait a minute and try again.');
const unavailable=()=>failure(503,'Harbor request protection is temporarily unavailable. Please try again shortly.');

export async function admitPortableLoginExchange(state:string){
  let decision;
  try{decision=await admitLoginCallback(portableDb(),await sha256(state),limits.login_callback);}
  catch{throw new GoogleLoginAdmissionError(unavailable());}
  if(decision==='limited')throw new GoogleLoginAdmissionError(limited());
  if(decision==='used')throw Error('This sign-in attempt was already used.');
}

export async function portableRateLimit(scope:BudgetScope,subject:string){
  try{
    if(await consumeBudget(portableDb(),scope,subject,limits[scope]))return null;
    return limited();
  }catch{
    return unavailable();
  }
}
