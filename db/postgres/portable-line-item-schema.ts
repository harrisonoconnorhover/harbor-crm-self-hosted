import {foreignKey,integer,jsonb,pgTable,primaryKey,text,uuid} from 'drizzle-orm/pg-core';
import type {AmountMetric,LineItem} from '../../lib/commerce';
import {deals} from './deal-schema';

export const portableLineItemSets=pgTable('portable_line_item_sets',{
  workspaceId:uuid('workspace_id').notNull(),
  dealId:uuid('deal_id').notNull(),
  revision:integer('revision').notNull(),
  amountMetric:text('amount_metric').$type<AmountMetric>().notNull(),
  items:jsonb('items').$type<LineItem[]>().notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.dealId]}),
  foreignKey({columns:[table.workspaceId,table.dealId],foreignColumns:[deals.workspaceId,deals.id]}),
]);
