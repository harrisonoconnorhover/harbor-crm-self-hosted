export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ACTIVITY_ATTACHMENTS = 20;
export type ActivityAttachment = { id:string; name:string; size:number; createdAt:string; createdBy:string;contentVersion?:string;replacedAt?:string;replacedBy?:string;archivedAt?:string;archivedBy?:string;archiveRevision?:number;trashedAt?:string;trashedBy?:string;trashRevision?:number };
// Sniff only browser-rendered raster formats; names and client MIME types are untrusted.
export function attachmentImageType(bytes:Uint8Array):string|null {
  const starts=(values:number[])=>values.every((v,i)=>bytes[i]===v);
  if(starts([137,80,78,71,13,10,26,10]))return 'image/png';
  if(starts([255,216,255]))return 'image/jpeg';
  const text=new TextDecoder('ascii').decode(bytes.subarray(0,12));
  if(text.startsWith('GIF87a')||text.startsWith('GIF89a'))return 'image/gif';
  if(text.startsWith('RIFF')&&text.slice(8,12)==='WEBP')return 'image/webp';
  return null;
}
export function attachmentName(value:string) {
  const name=value.normalize('NFC').trim();
  if(!name || name.length>200 || /[\x00-\x1f\x7f/\\]/.test(name)) throw Error('Use a file name of 1–200 characters without slashes or control characters.');
  return name;
}
export async function attachmentBytes(request:Pick<Request,'headers'|'body'>,maxBytes=MAX_ATTACHMENT_BYTES) {
  const declared=Number(request.headers.get('content-length'));
  if(declared>maxBytes) throw Error(maxBytes===MAX_ATTACHMENT_BYTES?'Files must be 10 MB or smaller.':'Request body exceeds its size limit.');
  if(!request.body) throw Error('Choose a non-empty file.');
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try { while(true) { const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>maxBytes){await reader.cancel();throw Error(maxBytes===MAX_ATTACHMENT_BYTES?'Files must be 10 MB or smaller.':'Request body exceeds its size limit.');}chunks.push(value);
  }} finally {reader.releaseLock();}
  if(!size)throw Error('Choose a non-empty file.');
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export function attachmentDisposition(name:string) {
  return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}`;
}

export const attachmentKey=(id:string,contentVersion?:string)=>`activity-files/${contentVersion||id}`;
