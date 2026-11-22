import {commerceSearchIndex,productSearchFields} from './commerce-search';
import {index,integer,jsonb,pgTable,primaryKey,timestamp,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import type {ProductData} from '../../lib/commerce';
import {privateWorkspaces} from './workspace-schema';

export const portableProducts=pgTable('portable_products',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull(),
  data:jsonb('data').$type<ProductData>().notNull(),
  archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  commerceSearchIndex('portable_products_text_search',productSearchFields(table.data)),
  primaryKey({columns:[table.workspaceId,table.id]}),
  index('portable_products_archive_catalog').on(table.workspaceId,sql`lower(${table.data}->>'name')`,table.id)
    .where(sql`${table.archivedAt} IS NOT NULL`),
  index('portable_products_workspace_catalog').on(table.workspaceId,table.archivedAt,sql`lower(${table.data}->>'name')`,table.id),
]);
