import {z} from 'zod';
import {MAX_ATTACHMENT_BYTES,attachmentName} from '../activity-attachments';
import {decode64} from './message';
import {decodedHeader,headersSchema} from './replies';
export const receivedFileQuery=z.union([
 z.object({sourceEmailId:z.string().guid("Invalid uuid"),replyId:z.string().min(1).max(200).regex(/^[\w-]+$/),part:z.string().regex(/^0(?:\.\d+){0,25}$/).max(150).optional()}).strict(),
 z.object({recordId:z.string().min(1).max(150),activityId:z.string().min(1).max(150),part:z.string().regex(/^0(?:\.\d+){0,25}$/).max(150).optional()}).strict(),
]);
export type ReceivedFileQuery=z.infer<typeof receivedFileQuery>;
export type ReceivedFile={part:string;name:string;size:number;downloadable:boolean};
export type ReceivedFileSource=ReceivedFile&{attachmentId?:string;data?:string};
export function receivedFileParts(raw:unknown):ReceivedFileSource[]{
 const payload=z.object({payload:z.unknown().optional()}).parse(raw).payload,files:ReceivedFileSource[]=[];let nodes=0;
 const schema=z.object({mimeType:z.string().max(100),filename:z.string().max(1000).default(''),headers:headersSchema.default([]),body:z.object({size:z.number().int().nonnegative().optional(),attachmentId:z.string().min(1).max(500).optional(),data:z.string().max(1000000).optional()}).prefault({}),parts:z.array(z.unknown()).max(200).default([])});
 function visit(value:unknown,path:string,depth:number){
  if(++nodes>300||depth>25)throw Error('This message has too many MIME parts. Open it in Gmail.');const p=schema.parse(value),type=p.mimeType.toLowerCase(),disposition=p.headers.find(h=>h.name.toLowerCase()==='content-disposition')?.value||'';
  const isFile=!!p.filename||/^attachment\b/i.test(disposition)||(!type.startsWith('multipart/')&&!['text/plain','text/html'].includes(type)&&(!!p.body.attachmentId||p.body.data!==undefined));
  if(isFile){if(files.length>=100)throw Error('This message has more than 100 files. Open it in Gmail.');let name=decodedHeader(p.filename).replace(/[\\/\x00-\x1f\x7f]/g,'_').slice(0,200).trim()||`Attachment ${files.length+1}`;try{encodeURIComponent(name);name=attachmentName(name);}catch{name=`Attachment ${files.length+1}`;}
   const size=p.body.size??(p.body.data!==undefined?decode64(p.body.data).length:-1);if(size<0)throw Error('Gmail did not provide the attachment size. Open it in Gmail.');
   files.push({part:path,name,size,downloadable:size<=MAX_ATTACHMENT_BYTES&&(!!p.body.attachmentId||p.body.data!==undefined),...p.body});return;
  }
  p.parts.forEach((child,i)=>visit(child,path+'.'+i,depth+1));
 }
 visit(payload,'0',0);return files;
}
export function receivedFileBytes(data:string,size:number){
 if(size>MAX_ATTACHMENT_BYTES||data.length>Math.ceil(MAX_ATTACHMENT_BYTES/3)*4+4||!/^[A-Za-z0-9_-]*={0,2}$/.test(data))throw Error('The received attachment is too large or unreadable.');
 const bytes=decode64(data);if(bytes.length!==size)throw Error('The received attachment download was incomplete. Try again.');return bytes;
}
