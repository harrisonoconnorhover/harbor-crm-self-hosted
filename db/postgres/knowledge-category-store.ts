import {and,asc,eq,isNotNull,isNull,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import type {z} from 'zod';
import {literalSearchPattern} from './search-index';
import {foldArticleText} from '../../lib/knowledge-base';
import type {KnowledgeCategoryPage,portableKnowledgeCategoryQuery,PortableKnowledgeCategoryMutation} from '../../lib/portable-knowledge';
import {knowledgeArticles as articles,knowledgeCategories as categories} from './knowledge-schema';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces as workspaces} from './workspace-schema';

type Tx=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
const unavailable=()=>new ApiError(404,'Category is unavailable.');

const projection={
  id:categories.id,parentId:categories.parentId,name:categories.name,description:categories.description,
  revision:categories.revision,updatedAt:categories.updatedAt,archivedAt:categories.archivedAt,
  parentName:sql<string|null>`(SELECT p.name FROM ${categories} p WHERE p.workspace_id=${categories.workspaceId} AND p.id=${categories.parentId})`,
  articleCount:sql<number>`(SELECT count(*)::int FROM ${articles} a WHERE a.workspace_id=${categories.workspaceId}
    AND a.archived_at IS NULL AND a.content->>'categoryId'=${categories.id}::text)`,
  childCount:sql<number>`(SELECT count(*)::int FROM ${categories} c WHERE c.workspace_id=${categories.workspaceId}
    AND c.parent_id=${categories.id} AND c.archived_at IS NULL)`,
};

export function readOwnedKnowledgeCategory(db:PostgresJsDatabase,actorId:string,id:string){
  return db.select(projection).from(categories).innerJoin(workspaces,eq(workspaces.id,categories.workspaceId))
    .where(and(eq(workspaces.ownerId,actorId),eq(categories.id,id))).then(rows=>rows[0]);
}

export async function listPortableKnowledgeCategories(db:PostgresJsDatabase,actorId:string,query:z.output<typeof portableKnowledgeCategoryQuery>):Promise<KnowledgeCategoryPage>{
  const {status,q,limit,afterName,afterId,topLevel}=query;
  const rows=await db.select(projection).from(categories).innerJoin(workspaces,eq(workspaces.id,categories.workspaceId))
    .where(and(eq(workspaces.ownerId,actorId),status==='archived'?isNotNull(categories.archivedAt):isNull(categories.archivedAt),
      topLevel?isNull(categories.parentId):undefined,
      q?sql`(${categories.nameKey} COLLATE "C") LIKE ${literalSearchPattern(foldArticleText(q))}`:undefined,
      afterId?sql`(${categories.nameKey},${categories.id})>(${foldArticleText(afterName??'')},${afterId}::uuid)`:undefined))
    .orderBy(asc(categories.nameKey),asc(categories.id)).limit(limit+1);
  const last=rows[limit-1];
  return {items:rows.slice(0,limit),next:rows.length>limit?{afterName:last.name,afterId:last.id}:null};
}

async function find(tx:Tx,workspaceId:string,id:string,lock?:'update'|'share'){
  const query=tx.select().from(categories).where(and(eq(categories.workspaceId,workspaceId),eq(categories.id,id)));
  const [row]=lock?await query.for(lock):await query;
  return row;
}

// Saving an article with a category takes a share lock, so an archive can't slip past it.
export async function requireActiveKnowledgeCategory(tx:Tx,workspaceId:string,id:string){
  const row=await find(tx,workspaceId,id,'share');
  if(!row||row.archivedAt!==null)throw new ApiError(409,'Choose an active category, or restore this one first.');
  return row;
}

export function mutatePortableKnowledgeCategory(db:PostgresJsDatabase,actorId:string,input:PortableKnowledgeCategoryMutation){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actorId,input.action==='save'&&input.revision===0);
    if(!workspaceId)throw unavailable();
    const existing=await find(tx,workspaceId,input.id,'update');
    const now=Date.now();
    if(input.action==='save'){
      const nameKey=foldArticleText(input.name);
      if(input.revision===0&&existing){
        // A repeated create returns the saved category.
        if(existing.revision===1&&existing.name===input.name&&existing.parentId===input.parentId&&existing.description===input.description)return existing;
        throw new ApiError(409,'That category ID is already used.');
      }
      if(input.revision!==0&&(!existing||existing.revision!==input.revision))throw existing?new ApiError(409,'Category changed. Reload it before saving.'):unavailable();
      if(existing?.archivedAt)throw new ApiError(409,'Restore this category before editing it.');
      if(input.parentId){
        const parent=await find(tx,workspaceId,input.parentId,'share');
        if(!parent||parent.parentId||parent.archivedAt!==null||parent.id===input.id)throw new ApiError(400,'Choose an active top-level category as the parent.');
        const [child]=existing?await tx.select({id:categories.id}).from(categories)
          .where(and(eq(categories.workspaceId,workspaceId),eq(categories.parentId,input.id))).limit(1):[];
        if(child)throw new ApiError(400,'A category with subcategories stays top-level.');
      }
      const [duplicate]=await tx.select({id:categories.id}).from(categories).where(and(eq(categories.workspaceId,workspaceId),
        input.parentId?eq(categories.parentId,input.parentId):isNull(categories.parentId),eq(categories.nameKey,nameKey))).limit(1);
      if(duplicate&&duplicate.id!==input.id)throw new ApiError(409,'Another category here already has this name.');
      const values={name:input.name,nameKey,description:input.description,parentId:input.parentId,updatedAt:now};
      if(!existing){
        const [row]=await tx.insert(categories).values({...values,workspaceId,id:input.id,revision:1,createdAt:now}).returning();
        return row!;
      }
      const [row]=await tx.update(categories).set({...values,revision:existing.revision+1})
        .where(and(eq(categories.workspaceId,workspaceId),eq(categories.id,input.id))).returning();
      return row!;
    }
    if(!existing)throw unavailable();
    if(existing.revision!==input.revision)throw new ApiError(409,'Category changed. Reload it before saving.');
    if((existing.archivedAt!==null)===input.archived)return existing;
    if(input.archived){
      const [inUse]=await tx.execute<{used:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM ${articles} WHERE workspace_id=${workspaceId}
        AND archived_at IS NULL AND content->>'categoryId'=${input.id}::text)
        OR EXISTS(SELECT 1 FROM ${categories} WHERE workspace_id=${workspaceId} AND parent_id=${input.id} AND archived_at IS NULL) AS used`);
      if(inUse?.used)throw new ApiError(409,'Move its active articles and archive its subcategories first.');
    }else if(existing.parentId){
      const parent=await find(tx,workspaceId,existing.parentId,'share');
      if(!parent||parent.archivedAt!==null)throw new ApiError(409,'Restore the parent category first.');
    }
    const [row]=await tx.update(categories).set({archivedAt:input.archived?now:null,revision:existing.revision+1,updatedAt:now})
      .where(and(eq(categories.workspaceId,workspaceId),eq(categories.id,input.id))).returning();
    return row!;
  });
}
