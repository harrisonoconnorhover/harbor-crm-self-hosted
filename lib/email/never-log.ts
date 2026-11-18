import {z} from 'zod';
import {emailAddress} from './message';
export function normalizeNeverLog(value:string){
 const text=value.trim().toLowerCase();if(text.includes('@')&&!text.startsWith('*@')&&!text.startsWith('@')){const parsed=emailAddress.safeParse(text);if(!parsed.success)throw Error('Enter a valid email address, such as person@example.com.');return parsed.data;}
 const domain=text.replace(/^\*?@/,'');if(domain.length>253||!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain))throw Error('Enter an email address or domain, such as person@example.com or *@example.com.');
 return '*@'+domain;
}
export const neverLogInput=z.object({id:z.string().guid("Invalid uuid"),value:z.string().min(1).max(256)}).strict().transform((v,c)=>{try{return {...v,value:normalizeNeverLog(v.value)};}catch{c.addIssue({code:'custom',message:'Enter an email address or domain, such as person@example.com or *@example.com.'});return z.NEVER;}});
export type NeverLogRule={id:string;value:string;createdAt:string};
export type NeverLogPage={results:NeverLogRule[];total:number;next:number|null};
