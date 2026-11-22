import {sql} from 'drizzle-orm';
import {bigint,boolean,integer,check,foreignKey,index,jsonb,pgTable,primaryKey,text,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
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
  index('portable_knowledge_text_search').using('gin',sql`(${table.searchText} COLLATE "C") public.gin_trgm_ops`),
  index('portable_knowledge_managed_category').on(table.workspaceId,sql`(${table.content}->>'categoryId')`),
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
  index('portable_knowledge_category_search').using('gin',sql`(${table.nameKey} COLLATE "C") public.gin_trgm_ops`),
  check('portable_knowledge_category_parent',sql`${table.parentId} IS DISTINCT FROM ${table.id}`),
]);

export const helpCenters=pgTable('portable_help_centers',{
  workspaceId:uuid('workspace_id').primaryKey().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull().unique(),name:text('name').notNull(),accent:text('accent').notNull(),
  enabled:boolean('enabled').notNull(),revision:integer('revision').notNull(),
},t=>[check('portable_help_brand',sql`char_length(trim(${t.name})) BETWEEN 1 AND 80 AND ${t.accent} ~ '^#[0-9a-fA-F]{6}$' AND ${t.revision}>0`)]);

export const articlePublications=pgTable('portable_article_publications',{
  workspaceId:uuid('workspace_id').notNull(),articleId:uuid('article_id').notNull(),
  publishedRevision:bigint('published_revision',{mode:'number'}),revision:integer('revision').notNull(),
  topic:text('public_topic'),
  searchText:text('search_text').notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.articleId]}),
  foreignKey({columns:[t.workspaceId,t.articleId],foreignColumns:[knowledgeArticles.workspaceId,knowledgeArticles.id]}),
  foreignKey({name:'portable_published_version_fk',columns:[t.workspaceId,t.articleId,t.publishedRevision],
    foreignColumns:[knowledgeVersions.workspaceId,knowledgeVersions.articleId,knowledgeVersions.revision]}),
  check('portable_publication_version',sql`${t.revision}>0 AND ((${t.publishedRevision} IS NOT NULL AND ${t.publishedRevision}>0) OR ${t.publishedRevision} IS NULL AND ${t.searchText}='')`),
  check('portable_public_topic_text',sql`${t.topic} IS NULL OR (char_length(${t.topic}) BETWEEN 1 AND 80 AND ${t.topic}=btrim(${t.topic}) AND ${t.topic} !~ '[[:cntrl:]]')`),
  index('portable_public_topic_articles').on(t.workspaceId,t.topic,t.articleId).where(sql`${t.publishedRevision} IS NOT NULL AND ${t.topic} IS NOT NULL`),
  index('portable_published_article_search').using('gin',sql`(${t.searchText} COLLATE "C") public.gin_trgm_ops`),
]);
