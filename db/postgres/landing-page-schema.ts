import {sql,type SQLWrapper} from 'drizzle-orm';
import {listSearchIndex} from './search-index';
import {check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,unique,uuid} from 'drizzle-orm/pg-core';
import type {LandingDraft} from '../../lib/portable-landing';
import {privateWorkspaces} from './workspace-schema';

export const landingTitle=(snapshot:SQLWrapper)=>sql<string>`${snapshot}->>'title'`;
export const landingSlug=(snapshot:SQLWrapper)=>sql<string>`${snapshot}->>'slug'`;

export const landingPages=pgTable('portable_landing_pages',{
  id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  revision:integer('revision').notNull(),draftRevision:integer('draft_revision').notNull(),draft:jsonb('draft').$type<LandingDraft>().notNull(),
  lastPublished:jsonb('last_published').$type<LandingDraft>(),
},t=>[listSearchIndex('portable_landing_search',landingTitle(t.draft),landingSlug(t.draft),landingTitle(t.lastPublished),landingSlug(t.lastPublished)),
  index('portable_landing_redirects').using('gin',sql`(${t.lastPublished}->'redirectFrom')`),
  unique('landing_page_workspace_key').on(t.workspaceId,t.id),check('landing_page_revisions',sql`${t.draftRevision} > 0 AND ${t.revision} >= ${t.draftRevision}`)]);
export const landingPublications=pgTable('portable_landing_publications',{
  workspaceId:uuid('workspace_id').notNull(),pageId:uuid('page_id').notNull(),slug:text('slug').notNull(),
  revision:integer('revision').notNull(),
},t=>[primaryKey({columns:[t.workspaceId,t.pageId]}),unique('landing_public_url').on(t.workspaceId,t.slug),
  foreignKey({columns:[t.workspaceId,t.pageId],foreignColumns:[landingPages.workspaceId,landingPages.id]}),
  check('landing_public_slug',sql`length(${t.slug}) <= 72 AND ${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND ${t.revision}>0`),
]);
