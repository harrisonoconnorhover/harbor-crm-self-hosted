import {boolean,check,integer,jsonb,pgTable,primaryKey,text,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import type {PortableRecordKind} from '../../lib/portable-records';
import type {PortableSavedViewFilters} from '../../lib/portable-saved-views';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

export const savedViews=pgTable('portable_saved_views',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  id:uuid('id').notNull(),
  kind:text('kind').$type<PortableRecordKind>().notNull(),
  name:text('name').notNull(),
  filters:jsonb('filters').$type<PortableSavedViewFilters>().notNull(),
  columns:jsonb('columns').$type<string[]>(),
  shared:boolean('shared').notNull().default(false),
  // The workspace editor who created the view; null for views created by the owner.
  authorId:text('author_id').references(()=>loginIdentities.id),
  revision:integer('revision').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  uniqueIndex('portable_saved_view_name').on(table.workspaceId,table.kind,sql`lower(${table.name})`),
  check('portable_saved_view_kind',sql`${table.kind} IN ('contacts','companies','deals')`),
  check('portable_saved_view_revision',sql`${table.revision} >= 1`),
  check('portable_saved_view_author_shared',sql`${table.authorId} IS NULL OR ${table.shared}`),
]);
