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
  primaryKey({columns:[table.workspaceId,table.id]}),
  index('portable_products_workspace_catalog').on(table.workspaceId,table.archivedAt,sql`lower(${table.data}->>'name')`,table.id),
]);
