import {z} from 'zod';
import type {ArticleContent} from './knowledge-base';

const id=z.string().guid("Invalid uuid");
const revision=z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const cursor=z.object({
  at:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id,
}).strict();

export const portableArticleList=z.object({
  status:z.enum(['draft','archived','all']).default('draft'),
  categoryId:id.optional(),
  q:z.string().trim().max(200).default(''),
  afterAt:cursor.shape.at.optional(),
  afterId:id.optional(),
}).strict().refine(input=>(input.afterAt===undefined)===(input.afterId===undefined));

export const portableArticleDetail=z.object({
  id,
  history:z.literal('1').optional(),
  version:revision.optional(),
  before:revision.optional(),
}).strict().refine(input=>!(input.history&&input.version)&&(!input.before||input.history));

export const portableArticlePath='/?view=knowledge';
export const portableArticleCopyPath=(id:string)=>portableArticlePath+'&article=new&copyOf='+id;

// An unsaved copy of a draft's authoring fields. A managed category that is no longer active is cleared.
export function portableArticleCopy(content:ArticleContent,activeCategoryIds:string[]){
  const title=('Copy of '+content.title).slice(0,200).replace(/[\uD800-\uDBFF]$/,'').trimEnd();
  const categoryCleared=!!content.categoryId&&!activeCategoryIds.includes(content.categoryId);
  return {categoryCleared,content:{...content,title,tags:[...content.tags],
    ...(content.categoryId?{category:'',categoryId:categoryCleared?null:content.categoryId}:{})}};
}

const categoryRevision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1);
export const portableKnowledgeCategoryMutation=z.discriminatedUnion('action',[
  z.object({action:z.literal('save'),id,revision:categoryRevision,name:z.string().trim().min(1).max(100),
    description:z.string().trim().max(400).default(''),parentId:id.nullable().default(null)}).strict(),
  z.object({action:z.literal('archive'),id,revision:categoryRevision.min(1),archived:z.boolean()}).strict(),
]);
export type PortableKnowledgeCategoryMutation=z.output<typeof portableKnowledgeCategoryMutation>;
export const portableKnowledgeCategoryQuery=z.object({status:z.enum(['active','archived']).default('active')}).strict();
export type PortableKnowledgeCategory={id:string;parentId:string|null;parentName:string|null;name:string;description:string;
  revision:number;updatedAt:number;archivedAt:number|null;articleCount:number;childCount:number};
