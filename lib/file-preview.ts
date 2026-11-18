export const TEXT_PREVIEW_BYTES=64*1024;
export type TextPreview={text:string;truncated:boolean};
export function textPreviewCandidate(name:string){return /\.(txt|md|csv|tsv|log|json|yaml|yml|xml)$/i.test(name);}
export function pdfSignature(bytes:Uint8Array){return /^%PDF-(1\.[0-7]|2\.0)(?:\s|$)/.test(new TextDecoder().decode(bytes.slice(0,16)));}
// Decode only a bounded excerpt. Streaming decode drops an incomplete final UTF-8
// character at the cutoff; it never changes the stored/downloaded file.
export function plainTextPreview(name:string,bytes:Uint8Array,size:number):TextPreview|null{
 if(!textPreviewCandidate(name))return null;
 const truncated=size>TEXT_PREVIEW_BYTES;
 try{
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.slice(0,TEXT_PREVIEW_BYTES),{stream:truncated});
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))return null;
  return {text,truncated};
 }catch{return null;}
}
