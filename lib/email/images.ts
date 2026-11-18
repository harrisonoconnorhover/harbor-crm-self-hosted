import {parseDocument} from 'htmlparser2';
import {emailAttachment,emailAttachments,type EmailAttachment,type EmailAttachmentData} from './attachments';
import {attachmentImageType} from '../activity-attachments';
const imagePath='/api/email/images?';
export function emailImageURL(file:EmailAttachment){const f=emailAttachment.parse(file);return imagePath+new URLSearchParams({id:f.id,name:f.name,size:String(f.size),contentVersion:f.contentVersion});}
export function parseEmailImageURL(src:string):EmailAttachment|null{if(!src.startsWith(imagePath)||src.includes('#')||src.length>2000)return null;try{const q=new URLSearchParams(src.slice(imagePath.length));if([...q.keys()].length!==4)return null;return emailAttachment.parse({...Object.fromEntries(q),size:Number(q.get('size'))});}catch{return null;}}
export const emailImageCid=(f:EmailAttachment)=>f.id+'.'+(f.contentVersion||'original')+'@harbor.invalid';
export function inlineEmailImages(html=''):EmailAttachment[]{
 if(html.length>128000)throw Error('Formatted message is too large.');const nodes=[...parseDocument(html).children],files:EmailAttachment[]=[];let count=0;
 while(nodes.length){const n=nodes.pop()!;if(++count>6000)throw Error('Message has too many formatting elements.');if('name' in n&&n.name==='img'&&'attribs' in n){const f=parseEmailImageURL(n.attribs.src||'');if(f)files.push(f);}if('children' in n)nodes.push(...n.children);}
 return mergeEmailFiles(files.reverse());
}
function mergeEmailFiles(files:EmailAttachment[]){const selected=new Map<string,EmailAttachment>();for(const f of files){const old=selected.get(f.id);if(old&&(old.contentVersion!==f.contentVersion||old.name!==f.name||old.size!==f.size))throw Error('The same file has conflicting versions. Remove it and insert the current file again.');selected.set(f.id,f);}return emailAttachments.parse([...selected.values()]);}
export function emailFileSelections(content:{bodyHtml?:string;attachments?:EmailAttachment[]}){return mergeEmailFiles([...(content.attachments||[]),...inlineEmailImages(content.bodyHtml)]);}
export function checkInlineImageBytes(html:string|undefined,files:EmailAttachmentData[]){for(const f of inlineEmailImages(html)){const data=files.find(v=>v.id===f.id);if(!data||!attachmentImageType(data.bytes))throw Error('Inline images must be PNG, JPEG, GIF or WebP files. Remove the image and choose a supported file.');}}
// Only canonical owned-file sources are substituted. Remote URLs never enter outgoing HTML.
export function emailImageDeliveryHTML(html:string){return html.replace(/src="([^"]+)"/g,(attribute,value)=>{const f=parseEmailImageURL(value.replaceAll('&amp;','&'));return f?'src="cid:'+emailImageCid(f)+'"':attribute;});}
