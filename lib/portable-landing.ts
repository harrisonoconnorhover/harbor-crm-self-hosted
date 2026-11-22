import {z} from 'zod';

export const landingStatuses={draft:'Private draft',published:'Published',changed:'Unpublished edits'} as const;
export type LandingListFilter={q?:string;status?:keyof typeof landingStatuses|'';after?:string};
export function landingListPath({q,status,after}:LandingListFilter){
  const params=new URLSearchParams({view:'landing-pages'});
  if(q)params.set('q',q);
  if(status)params.set('status',status);
  if(after)params.set('after',after);
  return '/?'+params;
}

export const maxLandingBlocks=30;
export const maxLandingImageChars=192*1024;
export const maxLandingImageSide=1600;
const maxPageImageChars=512*1024;
const imagePixels=z.number().int().min(1).max(maxLandingImageSide);
const jpeg=z.string().min(8).max(maxLandingImageChars).refine(value=>{
  if(value.length>maxLandingImageChars||value.length%4!==0||!value.startsWith('/9j/')||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))return false;
  try{return atob(value.slice(-8)).endsWith('\xff\xd9');}catch{return false;}
},'Choose a JPEG, PNG or WebP image to prepare for this page.');
const id=z.string().guid();
export const landingSlug=z.string().max(72).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/,'Use lowercase words separated by hyphens.');
const column=z.object({heading:z.string().trim().max(160),text:z.string().trim().min(1).max(2000)}).strict();
const website=z.string().trim().min(1).max(2048).refine(value=>{
  if(!/^https:\/\//i.test(value)||/[\s\\]/.test(value))return false;
  try{
    const url=new URL(value);
    return !!url.hostname&&!url.username&&!url.password;
  }catch{return false;}
},'Enter a full HTTPS website address without a username or password.');
const buttonTarget=z.union([z.object({url:website}).strict(),z.object({sectionId:id}).strict(),z.object({pageId:id}).strict()]);
const block=z.discriminatedUnion('type',[
  z.object({type:z.literal('heading'),id,text:z.string().trim().min(1).max(160)}).strict(),
  z.object({type:z.literal('text'),id,text:z.string().trim().min(1).max(4000)}).strict(),
  z.object({type:z.literal('quote'),id,text:z.string().trim().min(1).max(1000)}).strict(),
  z.object({type:z.literal('image'),id,jpeg,alt:z.string().trim().min(1,'Describe the image for readers.').max(300),
    caption:z.string().trim().max(300),width:imagePixels,height:imagePixels}).strict(),
  z.object({type:z.literal('columns'),id,left:column,right:column}).strict(),
  z.object({type:z.literal('button'),id,label:z.string().trim().min(1).max(70),target:buttonTarget}).strict(),
  z.object({type:z.literal('form'),id,label:z.string().trim().min(1).max(70),formId:id,display:z.enum(['button','inline']).optional()}).strict(),
]);
export const landingDraft=z.object({title:z.string().trim().min(1).max(120),slug:landingSlug,
  redirectFrom:z.array(landingSlug).max(20,'Keep up to 20 previous addresses.').optional(),
  searchTitle:z.string().trim().max(120).optional(),searchDescription:z.string().trim().max(300).optional(),
  excludeFromSearch:z.boolean().optional(),
  description:z.string().trim().max(300),accent:z.string().regex(/^#[0-9a-f]{6}$/i),
  blocks:z.array(block).max(maxLandingBlocks).refine(rows=>new Set(rows.map(row=>row.id)).size===rows.length,'Sections must have distinct IDs.'),
}).strict().superRefine(({blocks,slug,redirectFrom=[]},ctx)=>{
  if(redirectFrom.includes(slug)||new Set(redirectFrom).size!==redirectFrom.length){
    ctx.addIssue({code:'custom',path:['redirectFrom'],message:'List each previous address once and leave out the current page address.'});
  }
  if(blocks.reduce((sum,b)=>sum+(b.type==='image'?b.jpeg.length:0),0)>maxPageImageChars){
    ctx.addIssue({code:'custom',path:['blocks'],message:'This page has too much image data. Remove an image or choose smaller pictures.'});
  }
  const sections=new Set(blocks.filter(b=>b.type!=='button').map(b=>b.id));
  blocks.forEach((b,index)=>{
    if(b.type==='button'&&'sectionId' in b.target&&!sections.has(b.target.sectionId)){
      ctx.addIssue({code:'custom',path:['blocks',index,'target'],message:'Choose a section that is still on this page.'});
    }
  });
});
export type LandingDraft=z.infer<typeof landingDraft>;
export type LandingBlock=z.infer<typeof block>;
export function landingForOrigin(draft:LandingDraft,enabledForms:ReadonlyMap<string,string|null>,origin:string):LandingDraft{
  const blocks:LandingBlock[]=[];
  for(const block of draft.blocks){
    if(block.type==='form'){
      if(!enabledForms.has(block.formId))continue;
      if(block.display==='inline'&&enabledForms.get(block.formId)!==origin){
        blocks.push({...block,display:'button'});
        continue;
      }
    }
    blocks.push(block);
  }
  return {...draft,blocks};
}

const version={id,revision:z.number().int().nonnegative()};
export const landingChange=z.discriminatedUnion('action',[
  z.object({...version,action:z.literal('save'),draft:landingDraft}).strict(),
  z.object({...version,action:z.enum(['publish','withdraw'])}).strict(),
]);
export type LandingChange=z.infer<typeof landingChange>;
export type LandingPage={id:string;workspaceId:string;revision:number;draft:LandingDraft;lastPublished:LandingDraft|null;publishedSlug:string|null;publishedRevision:number|null;draftRevision:number};
