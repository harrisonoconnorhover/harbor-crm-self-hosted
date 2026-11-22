import {z} from 'zod';
import {escapeEmailText} from './email/rich-text';
import {httpURL} from './workflows/http';

export const harborEmailLimits={
  blocks:64,heading:220,paragraph:8_000,imageAlt:500,buttonLabel:120,url:2_048,preheader:200,
  htmlBytes:1_048_576,projectBytes:1_048_576,plainTextBytes:65_536,
} as const;

const limits=harborEmailLimits;
const utf8=new TextEncoder();
const blockId=z.uuid('Each block needs a valid ID.').toLowerCase();
const noControls=(s:string)=>!Array.from(s).some(c=>c<' '||c==='\x7f');
const requiredText=(limit:number,name:string)=>z.string().max(limit,`Keep ${name} within ${limit} characters.`)
  .refine(s=>s.trim().length>0,`Enter ${name}.`);
const line=(limit:number,name:string)=>requiredText(limit,name).refine(noControls,`Keep ${name} on one line.`);
const paragraph=requiredText(limits.paragraph,'paragraph text').transform(s=>s.replace(/\r\n?/g,'\n'))
  .refine(s=>noControls(s.replace(/[\n\t]/g,'')),'Remove control characters from the paragraph.');

function httpsDestination(value:string){
  // Email clients load these references. Harbor only validates and emits them.
  if(!/^https:\/\//i.test(value)||/[\s\\]/.test(value)||!noControls(value))return null;
  try{
    const destination=new URL(value);
    const authority=new URL(destination);
    authority.hash=''; // An email button may link to a section of a public web page.
    httpURL(authority.href);
    return destination.href;
  }catch{return null;}
}
const destination=z.string().max(limits.url).transform((value,ctx)=>{
  const url=httpsDestination(value);
  if(url&&url.length<=limits.url)return url;
  ctx.addIssue({code:'custom',message:'Enter a public HTTPS URL without a username or password.'});
  return z.NEVER;
});

const blockSchema=z.discriminatedUnion('type',[
  z.object({id:blockId,type:z.literal('heading'),text:line(limits.heading,'heading text')}).strict(),
  z.object({id:blockId,type:z.literal('paragraph'),text:paragraph}).strict(),
  z.object({id:blockId,type:z.literal('image'),url:destination,alt:line(limits.imageAlt,'image description')}).strict(),
  z.object({id:blockId,type:z.literal('button'),label:line(limits.buttonLabel,'button text'),url:destination}).strict(),
  z.object({id:blockId,type:z.literal('divider')}).strict(),
]);

const shape=z.object({
  kind:z.literal('harbor-email'),version:z.literal(1),
  accent:z.string().regex(/^#[a-fA-F0-9]{6}$/,'Choose a six-digit accent color.').toLowerCase(),
  preheader:z.string().max(limits.preheader).refine(noControls,'Keep preview text on one line.'),
  blocks:z.array(blockSchema).min(1,'Add a block to your email.').max(limits.blocks,'Use up to 64 blocks per email.'),
}).strict();
export type HarborEmailBlock=z.infer<typeof blockSchema>;
export type HarborEmailProject=z.infer<typeof shape>;

export function createHarborEmailBlock(type:HarborEmailBlock['type']):HarborEmailBlock{
  const id=crypto.randomUUID();
  switch(type){
    case 'heading':return {id,type,text:'Your headline'};
    case 'paragraph':return {id,type,text:'Write your message here.'};
    case 'image':return {id,type,url:'',alt:''};
    case 'button':return {id,type,label:'Read more',url:''};
    case 'divider':return {id,type};
  }
}

export function createHarborEmailProject(template:'blank'|'newsletter'|'announcement'):HarborEmailProject{
  const text=(type:'heading'|'paragraph',value:string)=>({id:crypto.randomUUID(),type,text:value});
  const blocks:HarborEmailBlock[]=template==='newsletter'?[
    text('heading','The monthly update'),text('paragraph','A few highlights from our team this month.'),
    createHarborEmailBlock('divider'),text('heading','Coming up'),text('paragraph','Here’s what we’re looking forward to next.'),
  ]:template==='announcement'?[
    text('heading','A note from our team'),text('paragraph','We have an update to share with you.'),
    createHarborEmailBlock('divider'),text('heading','What happens next'),text('paragraph','Thank you for being part of this next step.'),
  ]:[createHarborEmailBlock('paragraph')];
  return {kind:'harbor-email',version:1,accent:'#00696d',preheader:'',blocks};
}

function buttonInk(accent:string){
  const [r,g,b]=[1,3,5].map(offset=>{
    const channel=parseInt(accent.slice(offset,offset+2),16)/255;
    return channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4;
  });
  const luminance=.2126*r+.7152*g+.0722*b;
  return (luminance+.05)/.05>=1.05/(luminance+.05)?'#000000':'#ffffff';
}

function render(project:HarborEmailProject){
  const font='Arial,Helvetica,sans-serif',textParts=project.preheader?[project.preheader]:[];
  const rows:string[]=[];
  let firstHeading=true;
  for(const block of project.blocks){
    let content:string;
    switch(block.type){
      case 'heading':{
        const tag=firstHeading?'h1':'h2',size=firstHeading?32:23;
        content=`<${tag} style="margin:0;color:#193437;font-family:${font};font-size:${size}px;line-height:1.22;font-weight:700;">${escapeEmailText(block.text)}</${tag}>`;
        firstHeading=false;textParts.push(block.text);break;
      }
      case 'paragraph':
        content=`<p style="margin:0;color:#30494c;font-family:${font};font-size:16px;line-height:1.6;">${escapeEmailText(block.text).replaceAll('\n','<br>')}</p>`;
        textParts.push(block.text);break;
      case 'image':
        content=`<img width="552" src="${escapeEmailText(block.url)}" alt="${escapeEmailText(block.alt)}" style="display:block;width:100%;max-width:552px;height:auto;border:0;font:16px ${font};color:#30494c;background-color:#f2f6f5;">`;
        textParts.push(block.alt);break;
      case 'button':{
        const ink=buttonInk(project.accent);
        content=`<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="${project.accent}" style="border-radius:5px;mso-padding-alt:12px 20px;"><a href="${escapeEmailText(block.url)}" style="display:inline-block;padding:12px 20px;border-radius:5px;background-color:${project.accent};color:${ink};font:700 16px/1.3 ${font};text-decoration:none;">${escapeEmailText(block.label)}</a></td></tr></table>`;
        textParts.push(block.label+'\n'+block.url);break;
      }
      case 'divider':
        content='<div aria-hidden="true" style="height:1px;line-height:1px;font-size:1px;border-top:1px solid #d8e3e1;">&nbsp;</div>';
        textParts.push('---');break;
    }
    rows.push(`<tr><td style="padding:0 24px 20px;">${content}</td></tr>`);
  }
  const preview=project.preheader?`<div style="display:none;max-width:0;max-height:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeEmailText(project.preheader)}</div>`:'';
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background-color:#eff4f3;">${preview}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#eff4f3"><tr><td align="center" style="padding:24px 8px;">
<!--[if mso]><table role="presentation" align="center" width="600" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background-color:#ffffff;border-top:4px solid ${project.accent};"><tr><td height="24" aria-hidden="true" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>${rows.join('')}</table>
<!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
  return {html,plainText:textParts.join('\n\n')};
}

export const harborEmailProjectSchema=shape.superRefine((project,ctx)=>{
  if(ctx.issues.length)return;
  const ids=new Set(project.blocks.map(block=>block.id));
  if(ids.size!==project.blocks.length){
    ctx.addIssue({code:'custom',path:['blocks'],message:'Every block must have its own ID.'});
    return;
  }
  if(utf8.encode(JSON.stringify(project)).length>limits.projectBytes){
    ctx.addIssue({code:'custom',message:'Shorten the design to fit within 1 MiB.'});
    return;
  }
  const {html,plainText}=render(project);
  if(utf8.encode(plainText).length>limits.plainTextBytes){
    ctx.addIssue({code:'custom',path:['blocks'],message:'Shorten the email so its plain-text version fits within 64 KiB.'});
  }
  if(utf8.encode(html).length>limits.htmlBytes){
    ctx.addIssue({code:'custom',path:['blocks'],message:'Shorten the email so its HTML fits within 1 MiB.'});
  }
});

export function parseSavedHarborEmail(project:string):HarborEmailProject|null{
  if(project.length>limits.projectBytes||utf8.encode(project).length>limits.projectBytes)return null;
  try{
    const parsed=harborEmailProjectSchema.safeParse(JSON.parse(project));
    return parsed.success?parsed.data:null;
  }catch{return null;}
}

export function renderHarborEmail(project:HarborEmailProject):{html:string;plainText:string}{
  return render(harborEmailProjectSchema.parse(project));
}
