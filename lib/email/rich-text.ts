import {parseEmailImageURL,emailImageURL,inlineEmailImages} from './images';
import type {EmailAttachment} from './attachments';
import {parseDocument} from 'htmlparser2';

export const richHtmlLimit=128000;
type Node={text:string}|{tag:string;href?:string;image?:EmailAttachment;alt?:string;width?:number;children:Node[]};
type Parsed=ReturnType<typeof parseDocument>['children'][number];
const tags:Record<string,string>={p:'p',div:'div',br:'br',b:'strong',strong:'strong',i:'em',em:'em',u:'u',s:'s',strike:'s',ul:'ul',ol:'ol',li:'li',a:'a',blockquote:'blockquote',h1:'p',h2:'p',h3:'p'};
const blocked=new Set(['script','style','iframe','object','embed','svg','math','template','noscript','form','textarea','select','button','input']);
export const escapeEmailText=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export function safeEmailLink(value:string){
 const raw=value.trim();if(raw.length>2048||/[\x00-\x20\x7f{}]/.test(raw))return null;
 try{const url=new URL(raw);return ['https:','http:','mailto:','tel:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
function parseRich(html:string){
 if(html.length>richHtmlLimit)throw Error('Formatted message exceeds 128,000 characters.');let count=0;
 const walk=(nodes:Parsed[],depth:number):Node[]=>{if(depth>40)throw Error('Message formatting is nested too deeply.');const out:Node[]=[];
  for(const node of nodes){if(++count>6000)throw Error('Message has too many formatting elements.');
   if(node.type==='text'){out.push({text:node.data.replaceAll('\u00a0',' ')});continue;}
   if(!('name' in node)||!('children' in node)||!('attribs' in node)||blocked.has(node.name))continue;
   if(node.name==='img'){const image=parseEmailImageURL(node.attribs.src||'');if(image){const width=Number(node.attribs.width);out.push({tag:'img',image,alt:(node.attribs.alt||image.name).slice(0,500),...(Number.isInteger(width)&&width>=16&&width<=1200?{width}:{}),children:[]});}continue;}
   const children=walk(node.children,depth+1),tag=Object.hasOwn(tags,node.name)?tags[node.name]:undefined;
   if(!tag){out.push(...children);continue;}
   const href=tag==='a'?safeEmailLink(node.attribs.href||''):undefined;
   if(tag==='a'&&!href){out.push(...children);continue;}
   out.push({tag,children,...(href?{href}:{})});
  }return out;
 };return walk(parseDocument(html,{decodeEntities:true}).children,0);
}
function serialize(nodes:Node[]):string{return nodes.map(n=>'text' in n?escapeEmailText(n.text).replace(/\r\n|\r|\n/g,'<br>'):n.image?'<img src="'+escapeEmailText(emailImageURL(n.image))+'" alt="'+escapeEmailText(n.alt||n.image.name)+'"'+(n.width?' width="'+n.width+'"':'')+'>':n.tag==='br'?'<br>':'<'+n.tag+(n.href?' href="'+escapeEmailText(n.href)+'"':'')+'>'+serialize(n.children)+'</'+n.tag+'>').join('');}
function plain(nodes:Node[],parent=''):string{return nodes.map((n,i)=>{
 if('text' in n)return n.text;if(n.image)return '[Image: '+(n.alt||n.image.name)+']';if(n.tag==='br')return '\n';let text=plain(n.children,n.tag);
 if(n.tag==='a'&&n.href&&text!==n.href)text+=' ('+n.href+')';
 if(n.tag==='li')return '\n'+(parent==='ol'?nodes.slice(0,i+1).filter(x=>'tag' in x&&x.tag==='li').length+'. ':'• ')+text.trim()+'\n';
 return ['p','div','ul','ol','blockquote'].includes(n.tag)?'\n'+text+'\n':text;
 }).join('');}
function result(nodes:Node[]){const body=plain(nodes).replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim(),bodyHtml=serialize(nodes);if(body.length>32000||bodyHtml.length>richHtmlLimit)throw Error('Formatted message exceeds its text or formatting limit.');inlineEmailImages(bodyHtml);return {body,bodyHtml};}
export function normalizeRichText(html:string){return result(parseRich(html));}
export function plainEmailHtml(body:string){return '<div>'+escapeEmailText(body).replace(/\r\n|\r|\n/g,'<br>')+'</div>';}
export function normalizeEmailBody<T extends {body:string;bodyHtml?:string}>(v:T):T{return v.bodyHtml?{...v,...normalizeRichText(v.bodyHtml)}:v;}
// Transform text nodes only: a CRM property can never create markup or a link destination.
export function mapRichText(html:string,transform:(text:string)=>string){
 const walk=(nodes:Node[]):Node[]=>nodes.map(n=>'text' in n?{text:transform(n.text)}:{...n,children:walk(n.children)});
 return result(walk(parseRich(html)));
}
export function richTextRuns(html:string){const out:string[]=[];const walk=(nodes:Node[])=>{for(const n of nodes)if('text' in n)out.push(n.text);else walk(n.children);};walk(parseRich(html));return out;}
export function appendEmailSignature<T extends {body:string;bodyHtml?:string}>(content:T,signature:string,signatureHtml?:string):T{
 if(signatureHtml){const rich=normalizeRichText(signatureHtml),current=normalizeEmailBody(content);if(!rich.body.trim()||current.body===rich.body||current.body.endsWith('\n\n'+rich.body))return content;return {...content,...normalizeRichText((current.bodyHtml||plainEmailHtml(current.body))+(current.body?'<div><br></div>':'')+rich.bodyHtml)};}
 if(content.bodyHtml)signature=normalizeRichText(plainEmailHtml(signature)).body;
 if(!signature.trim()||content.body===signature||content.body.endsWith('\n\n'+signature))return content;
 const body=content.body+(content.body?'\n\n':'')+signature;if(body.length>32000)throw Error('Message plus signature exceeds 32,000 characters.');
 return content.bodyHtml?{...content,...normalizeRichText(content.bodyHtml+'<div><br></div><p>'+escapeEmailText(signature).replace(/\r\n|\r|\n/g,'<br>')+'</p>')}:{...content,body};
}

// Replace only an exact signature suffix from this composer session. Never
// remove user-edited text or guess a signature in an older saved message.
export function removeEmailSignature<T extends {body:string;bodyHtml?:string}>(content:T,signature:string,signatureHtml?:string):T|null{
 try{if(!signature.trim())return null;
 if(content.bodyHtml){const current=normalizeRichText(content.bodyHtml),suffix=normalizeRichText(signatureHtml||'<p>'+escapeEmailText(signature).replace(/\r\n|\r|\n/g,'<br>')+'</p>').bodyHtml;if(!current.bodyHtml.endsWith(suffix))return null;return {...content,...normalizeRichText(current.bodyHtml.slice(0,-suffix.length))};}
 if(content.body===signature)return {...content,body:''};if(content.body.endsWith('\n\n'+signature))return {...content,body:content.body.slice(0,-signature.length-2)};return null;}catch{return null;}
}
