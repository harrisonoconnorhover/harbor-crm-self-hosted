import {z} from 'zod';
import {parseDocument} from 'htmlparser2';
import {safeEmailLink,escapeEmailText} from './email/rich-text';

export const articleHtmlLimit=128000;
export class ArticleContentError extends Error{}
export const foldArticleText=(value:string)=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s+/g,' ').trim();
const allowed=new Set(['p','div','br','strong','em','u','s','ul','ol','li','a','blockquote','h2','h3','pre','code','hr']);
const blocked=new Set(['script','style','iframe','object','embed','svg','math','template','noscript','form','textarea','select','button','input','img','video','audio']);
const aliases:Record<string,string>={b:'strong',i:'em',strike:'s',h1:'h2'};
export function normalizeArticleHtml(html:string):{bodyHtml:string;bodyText:string}{
 if(html.length>articleHtmlLimit)throw new ArticleContentError('Article formatting exceeds 128,000 characters.');
 let count=0;
 const walk=(nodes:ReturnType<typeof parseDocument>['children'],depth:number):{html:string;text:string}=>{
  if(depth>40)throw new ArticleContentError('Article formatting is nested too deeply.');
  const parts=nodes.map(node=>{
   if(++count>6000)throw new ArticleContentError('Article has too many formatting elements.');
   if(node.type==='text')return {html:escapeEmailText(node.data),text:node.data.replaceAll('\u00a0',' ')};
   if(!('name'in node)||!('children'in node)||!('attribs'in node)||blocked.has(node.name))return{html:'',text:''};
   const children=walk(node.children,depth+1),tag=aliases[node.name]||node.name;
   if(!allowed.has(tag))return children;
   const href=tag==='a'?safeEmailLink(node.attribs.href||''):null;
   if(tag==='a'&&!href)return children;
   if(tag==='br'||tag==='hr')return{html:'<'+tag+'>',text:'\n'};
   const block=['p','div','ul','ol','li','blockquote','h2','h3','pre','br','hr'].includes(tag);
   return{html:tag==='br'||tag==='hr'?'<'+tag+'>':'<'+tag+(href?' href="'+escapeEmailText(href)+'" target="_blank" rel="noopener noreferrer"':'')+'>'+children.html+'</'+tag+'>',text:(block?'\n':'')+children.text+(block?'\n':'')};
  });return{html:parts.map(p=>p.html).join(''),text:parts.map(p=>p.text).join('')};
 };
 const parsed=walk(parseDocument(html,{decodeEntities:true}).children,0),bodyText=parsed.text.replace(/\n{3,}/g,'\n\n').trim();
 if(bodyText.length>64000||parsed.html.length>articleHtmlLimit)throw new ArticleContentError('Article exceeds 64,000 text characters or its formatting limit.');
 return{bodyHtml:bodyText?parsed.html:'<p></p>',bodyText};
}
export const plainArticleHtml=(text:string)=>'<p>'+escapeEmailText(text).replace(/\r\n|\r|\n/g,'<br>')+'</p>';
export const articleContentSchema=z.object({
 title:z.string().trim().min(1,'Give the article a title.').max(200),subtitle:z.string().trim().max(400).default(''),category:z.string().trim().max(203).default(''),categoryId:z.string().guid("Invalid uuid").nullable().default(null),
 tags:z.array(z.string().trim().min(1).max(40)).max(20).default([]).refine(v=>new Set(v.map(foldArticleText)).size===v.length,'Use each tag once.'),
 bodyHtml:z.string().max(articleHtmlLimit).default('<p></p>'),
}).strict();
export type ArticleContent=z.infer<typeof articleContentSchema>;
export const emptyArticle:ArticleContent={title:'',subtitle:'',category:'',categoryId:null,tags:[],bodyHtml:'<p></p>'};
export const articleMutation=z.discriminatedUnion('action',[
 z.object({action:z.literal('save'),id:z.string().guid("Invalid uuid"),revision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1),content:articleContentSchema}).strict(),
 z.object({action:z.literal('restore'),id:z.string().guid("Invalid uuid"),revision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER-1),sourceRevision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER-1)}).strict(),
 z.object({action:z.literal('archive'),id:z.string().guid("Invalid uuid"),revision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER-1),archived:z.boolean()}).strict(),
]);
export const articleListInput=z.object({q:z.string().trim().max(200).default(''),categoryId:z.string().guid("Invalid uuid").optional(),status:z.enum(['all','draft','published','archived']).default('all'),page:z.coerce.number().int().min(0).max(1000000).default(0),sort:z.enum(['updated','title']).default('updated')}).strict();
export type ArticleSummary={id:string;title:string;subtitle:string;category:string;categoryId:string|null;tags:string[];revision:number;createdAt:string;updatedAt:string;archivedAt:string|null;publishedRevision:number|null;publishedAt:string|null;publishedSlug:string|null;publishedCategoryChanged:boolean;publishedContentChanged:boolean;excerpt:string};
export type KnowledgeArticle=Omit<ArticleSummary,'excerpt'|'publishedRevision'|'publishedAt'|'publishedSlug'|'publishedCategoryChanged'|'publishedContentChanged'>&{bodyHtml:string};
export type ArticlePage={items:ArticleSummary[];count:number;page:number;size:number};
export function articleContent(article:Omit<ArticleContent,'categoryId'>&{categoryId?:string|null}):ArticleContent{return{title:article.title,subtitle:article.subtitle,category:article.category,categoryId:article.categoryId??null,tags:article.tags,bodyHtml:article.bodyHtml};}
export function sameArticleContent(a:ArticleContent,b:ArticleContent){const normalize=(v:ArticleContent)=>({...articleContent(v),category:v.categoryId?'':v.category});return JSON.stringify(normalize(a))===JSON.stringify(normalize(b));}

export type ArticleVersionAction='created'|'saved'|'restored'|'archived'|'unarchived'|'baseline';
export type ArticleVersionSummary={revision:number;title:string;action:ArticleVersionAction;sourceRevision:number|null;savedAt:string;archivedAt:string|null;current:boolean;changedById:string|null;changedByName:string|null};
export type ArticleVersion=ArticleVersionSummary&ArticleContent;
export type ArticleVersionPage={items:ArticleVersionSummary[];count:number;page:number;size:number};
export const articleVersionLabel=(v:Pick<ArticleVersionSummary,'action'|'sourceRevision'>)=>({created:'Created',saved:'Saved draft',restored:'Restored from version '+v.sourceRevision,archived:'Archived',unarchived:'Restored to drafts',baseline:'Existing saved draft'})[v.action];
