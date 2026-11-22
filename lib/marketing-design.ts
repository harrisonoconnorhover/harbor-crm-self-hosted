import {z} from 'zod';
import {harborEmailProjectSchema,renderHarborEmail} from './harbor-email-design';

const guid=z.string().guid().transform(value=>value.toLowerCase());
const singleLine=(max:number)=>z.string().trim().min(1).max(max).refine(
  value=>!/[\u0000-\u001f\u007f]/.test(value),'Use a single line of text.');
const textLimit=1024*1024;
const content=(limit:number)=>z.string().max(limit).refine(value=>!value.includes('\0'),'Remove unsupported control characters.');

export function isBeefreeDesign(value:string){
  try{
    const project=JSON.parse(value),page=project?.page;
    return project?.kind!=='harbor-email'&&Boolean(page)&&typeof page==='object'&&!Array.isArray(page);
  }catch{return false;}
}

export const marketingDesignQuery=z.union([z.object({id:guid}).strict(),z.object({after:guid.optional()}).strict()]);
const designFields={
  id:guid,expectedRevision:z.number().int().min(1).max(2147483646).optional(),
  name:singleLine(120),subject:singleLine(200),
};
export const marketingDesignSave=z.object({
  action:z.literal('save'),...designFields,plainText:content(64*1024).default(''),
  project:content(textLimit).refine(isBeefreeDesign,'Beefree returned an invalid design. Reopen the editor and save again.'),
  html:content(textLimit).refine(value=>Boolean(value.trim()),'Save the design in Beefree to generate the email.'),
}).strict();
const nativeDesignSave=z.object({action:z.literal('saveNative'),...designFields,project:harborEmailProjectSchema}).strict();
export const marketingDesignAction=z.discriminatedUnion('action',[
  z.object({action:z.literal('session')}).strict(),marketingDesignSave,nativeDesignSave,
]);
// JSON strings include HTML and the editable project. Check bytes before parsing, including escape overhead.
export const marketingDesignBodyLimit=3*1024*1024;
export type MarketingDesignSave=z.output<typeof marketingDesignSave>;
export function renderNativeDesignSave(input:z.output<typeof nativeDesignSave>):MarketingDesignSave{
  const {project,...metadata}=input;
  return {...metadata,action:'save',project:JSON.stringify(project),...renderHarborEmail(project)};
}
export type MarketingDesignSummary={id:string;name:string;subject:string;revision:number};
export type MarketingDesign=MarketingDesignSummary&{project:string;html:string;plainText:string};
