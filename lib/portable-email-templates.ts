import {z} from 'zod';
import {parseTemplateToken,personalizeTemplate} from './email/templates';

const id=z.string().guid("Invalid uuid").transform(value=>value.toLowerCase());
const revision=z.number().int().min(0).max(2147483646);
const noControls=(value:string)=>!/[\x00-\x1f\x7f]/.test(value);
const tokens=['record.name','record.email','contact.name','contact.email','sender.name'] as const;
const tokenKeys=new Set<string>(tokens);
const mergeToken=/\{\{([^{}]+)\}\}/g;
const validTokens=(value:string)=>{
  const matches=[...value.matchAll(mergeToken)];
  const leftover=value.replace(mergeToken,'');
  if(matches.length>200||leftover.includes('{{')||leftover.includes('}}'))return false;
  try{return matches.every(match=>tokenKeys.has(parseTemplateToken(match[1]).key));}
  catch{return false;}
};
const tokenHelp='Use Contact name, Contact email or sender name merge fields.';
export const portableTemplateSave=z.object({
  id,expectedRevision:revision.optional(),
  name:z.string().trim().min(1).max(120).refine(noControls),
  subject:z.string().trim().min(1).max(200).refine(noControls).refine(validTokens,tokenHelp),
  body:z.string().trim().min(1).max(8000).refine(value=>!value.includes('\0')).refine(validTokens,tokenHelp),
}).strict();
export const portableTemplateDelete=z.object({id,expectedRevision:revision}).strict();
export const portableTemplateQuery=z.union([
  z.object({id,contactId:id.optional()}).strict(),
  z.object({search:z.string().trim().max(120).refine(noControls).optional(),after:id.optional()}).strict(),
]);
export type PortableTemplateSave=z.output<typeof portableTemplateSave>;
export type PortableTemplateDelete=z.output<typeof portableTemplateDelete>;

export function renderPortableTemplate(template:{subject:string;body:string},contact:Record<string,unknown>,sender:string){
  const name=typeof contact.name==='string'?contact.name:'';
  const email=typeof contact.email==='string'?contact.email:'';
  const values={'record.name':name,'contact.name':name,'record.email':email,'contact.email':email,'sender.name':sender};
  try{
    const {subject,body,missing}=personalizeTemplate(template,values);
    if(!subject.trim()||!body.trim()||body.length>8000||body.includes(String.fromCharCode(0)))return null;
    return {subject,body,missing};
  }catch{return null;}
}
