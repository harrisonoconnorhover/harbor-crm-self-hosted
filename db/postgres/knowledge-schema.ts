import {sql} from 'drizzle-orm';
import {bigint,check,foreignKey,index,jsonb,pgTable,primaryKey,text,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import type {ArticleContent,ArticleVersionAction} from '../../lib/knowledge-base';
import {privateWorkspaces} from './workspace-schema';

export const knowledgeArticles=pgTable('portable_knowledge_articles',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  content:jsonb('content').$type<ArticleContent>().notNull(),
  excerpt:text('excerpt').notNull(),
  searchText:text('search_text').notNull(),
  revision:bigint('revision',{mode:'number'}).notNull(),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
  updatedAt:bigint('updated_at',{mode:'number'}).notNull(),
  archivedAt:bigint('archived_at',{mode:'number'}),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  index('portable_knowledge_articles_recent').on(table.workspaceId,table.updatedAt,table.id),
]);

export const knowledgeVersions=pgTable('portable_knowledge_versions',{
  workspaceId:uuid('workspace_id').notNull(),
  articleId:uuid('article_id').notNull(),
  revision:bigint('revision',{mode:'number'}).notNull(),
  content:jsonb('content').$type<ArticleContent>().notNull(),
  action:text('action').$type<ArticleVersionAction>().notNull(),
  sourceRevision:bigint('source_revision',{mode:'number'}),
  savedAt:bigint('saved_at',{mode:'number'}).notNull(),
  archivedAt:bigint('archived_at',{mode:'number'}),
  changedById:text('changed_by_id').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.articleId,table.revision]}),
  foreignKey({name:'portable_knowledge_version_article_fk',columns:[table.workspaceId,table.articleId],
    foreignColumns:[knowledgeArticles.workspaceId,knowledgeArticles.id]}),
]);

// Managed categories: one level of subcategories, archived rather than deleted.
export const knowledgeCategories=pgTable('portable_knowledge_categories',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  parentId:uuid('parent_id'),
  name:text('name').notNull(),
  nameKey:text('name_key').notNull(),
  description:text('description').notNull(),
  revision:bigint('revision',{mode:'number'}).notNull(),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
  updatedAt:bigint('updated_at',{mode:'number'}).notNull(),
  archivedAt:bigint('archived_at',{mode:'number'}),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({name:'portable_knowledge_category_parent_fk',columns:[table.workspaceId,table.parentId],foreignColumns:[table.workspaceId,table.id]}),
  uniqueIndex('portable_knowledge_category_name').on(table.workspaceId,sql`coalesce(${table.parentId},'00000000-0000-0000-0000-000000000000'::uuid)`,table.nameKey),
  check('portable_knowledge_category_parent',sql`${table.parentId} IS DISTINCT FROM ${table.id}`),
]);
