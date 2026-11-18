import {bigint,check,foreignKey,index,integer,pgTable,primaryKey,text,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import type {PortableOutreach} from '../../lib/portable-contact-activities';
import {companies} from './company-schema';
import {deals} from './deal-schema';
import {loginIdentities} from './identity-schema';

export const portableRecordActivities=pgTable('portable_record_activities',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull().default(1),
  companyId:uuid('company_id'),
  dealId:uuid('deal_id'),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  kind:text('kind').$type<PortableOutreach['kind']>().notNull(),
  occurredAt:bigint('occurred_at',{mode:'number'}).notNull(),
  recordedAt:bigint('recorded_at',{mode:'number'}).notNull(),
  summary:text('summary').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({name:'portable_record_activity_company_fk',columns:[table.workspaceId,table.companyId],foreignColumns:[companies.workspaceId,companies.id]}),
  foreignKey({name:'portable_record_activity_deal_fk',columns:[table.workspaceId,table.dealId],foreignColumns:[deals.workspaceId,deals.id]}),
  index('portable_company_activity_order').on(table.workspaceId,table.companyId,table.occurredAt,table.id).where(sql`${table.companyId} IS NOT NULL`),
  index('portable_deal_activity_order').on(table.workspaceId,table.dealId,table.occurredAt,table.id).where(sql`${table.dealId} IS NOT NULL`),
  check('portable_record_activity_home',sql`num_nonnulls(${table.companyId},${table.dealId}) = 1`),
  check('portable_record_activity_kind',sql`${table.kind} IN ('Note','Email','Call','Meeting','LinkedIn','SMS','WhatsApp','Postal mail')`),
]);
