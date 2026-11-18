import {gmailRaw,decode64,type EmailThreadContext,type EmailContent} from './message';
import type {EmailAttachmentData} from './attachments';
import {emailFileSelections,inlineEmailImages,emailImageCid,checkInlineImageBytes} from './images';
import {attachmentImageType} from '../activity-attachments';
// Keep the binary set within20 MB and base64-encode only small chunks.
export function gmailAttachmentStream(content:EmailContent,sender:string,messageId:string,at:string,files:EmailAttachmentData[],thread?:EmailThreadContext|null){
 const selected=emailFileSelections(content),images=inlineEmailImages(content.bodyHtml),inline=new Set(images.map(f=>f.id));
 if(!selected.length||selected.length!==files.length||selected.some((f,i)=>f.id!==files[i].id||f.name!==files[i].name||f.size!==files[i].size||f.contentVersion!==files[i].contentVersion))throw Error('Attachment payload does not match the saved email.');
 if(files.some(f=>f.bytes.byteLength!==f.size))throw Error('Attachment size does not match.');checkInlineImageBytes(content.bodyHtml,files);
 const base=new TextDecoder().decode(decode64(gmailRaw({...content,attachments:undefined},sender,messageId,at,true,thread))),divider='\r\nMIME-Version: 1.0\r\n',split=base.indexOf(divider),mixed='harbor_mixed_'+crypto.randomUUID(),related='harbor_related_'+crypto.randomUUID(),enc=new TextEncoder(),ordinary=files.filter(f=>!inline.has(f.id));
 function* filePart(file:EmailAttachmentData,boundary:string,isInline:boolean){
  const name=encodeURIComponent(file.name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  // Plain parameters win in Gmail. Never offer a competing lossy or MIME-word filename.
  const fallback=/^[\x20-\x7e]+$/.test(file.name)&&!/=[?].*[?]=/.test(file.name)?file.name.replace(/[\\"]/g,'\\$&'):'';
  const parts:string[]=[];let part='';for(const unit of name.match(/%[0-9A-F]{2}|./g)||[]){if(part.length+unit.length>45){parts.push(part);part='';}part+=unit;}parts.push(part);const disposition=name.length<=60?"\r\n filename*=UTF-8''"+name:parts.map((p,i)=>'\r\n filename*'+i+'*='+(i===0?"UTF-8''":'')+p).join(';');
  yield enc.encode('--'+boundary+'\r\nContent-Type: '+(isInline?attachmentImageType(file.bytes):'application/octet-stream')+'\r\n'+(isInline?'Content-ID: <'+emailImageCid(file)+'>\r\n':'')+'Content-Disposition: '+(isInline?'inline':'attachment')+';'+(fallback?' filename="'+fallback+'";':'')+disposition+'\r\nContent-Transfer-Encoding: base64\r\n\r\n');
  for(let offset=0;offset<file.bytes.length;offset+=57*512){let raw='';for(const byte of file.bytes.subarray(offset,offset+57*512))raw+=String.fromCharCode(byte);yield enc.encode(btoa(raw).match(/.{1,76}/g)!.join('\r\n')+'\r\n');}
 }
 function* chunks(){
  yield enc.encode(base.slice(0,split)+divider);
  if(ordinary.length)yield enc.encode('Content-Type: multipart/mixed; boundary="'+mixed+'"\r\n\r\n--'+mixed+'\r\n');
  if(images.length)yield enc.encode('Content-Type: multipart/related; boundary="'+related+'"; type="multipart/alternative"\r\n\r\n--'+related+'\r\n');
  yield enc.encode(base.slice(split+divider.length)+'\r\n');
  if(images.length){for(const f of files.filter(f=>inline.has(f.id)))yield* filePart(f,related,true);yield enc.encode('--'+related+'--\r\n');}
  for(const f of ordinary)yield* filePart(f,mixed,false);
  if(ordinary.length)yield enc.encode('--'+mixed+'--\r\n');
 }
 const parts=chunks();return new ReadableStream<Uint8Array>({pull(c){const next=parts.next();if(next.done)c.close();else c.enqueue(next.value);},cancel(){parts.return();}});
}

// Google metadata precedes the MIME message; bytes remain streamed, including cancellation.
export function gmailThreadUpload(mime:ReadableStream<Uint8Array>,threadId:string){
 const boundary='harbor_upload_'+crypto.randomUUID(),reader=mime.getReader(),enc=new TextEncoder();let started=false;
 return {contentType:'multipart/related; boundary="'+boundary+'"',body:new ReadableStream<Uint8Array>({async pull(c){if(!started){started=true;c.enqueue(enc.encode('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify({threadId})+'\r\n--'+boundary+'\r\nContent-Type: message/rfc822\r\n\r\n'));return;}try{const next=await reader.read();if(next.done){reader.releaseLock();c.enqueue(enc.encode('\r\n--'+boundary+'--\r\n'));c.close();}else c.enqueue(next.value);}catch(e){reader.releaseLock();c.error(e);}},async cancel(reason){await reader.cancel(reason);reader.releaseLock();}})};
}
