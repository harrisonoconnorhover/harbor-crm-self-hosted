import {bigint,check,foreignKey,index,integer,pgTable,primaryKey,text,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import type {PortableOutreach} from '../../lib/portable-contact-activities';
import {contacts} from './contact-schema';
import {loginIdentities} from './identity-schema';

export const portableContactActivities=pgTable('portable_contact_activities',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull().default(1),
  contactId:uuid('contact_id').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  kind:text('kind').$type<PortableOutreach['kind']>().notNull(),
  occurredAt:bigint('occurred_at',{mode:'number'}).notNull(),
  recordedAt:bigint('recorded_at',{mode:'number'}).notNull(),
  summary:text('summary').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({columns:[table.workspaceId,table.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  index('portable_contact_activity_order').on(table.workspaceId,table.contactId,table.occurredAt,table.id),
  check('portable_contact_activity_kind',sql`${table.kind} IN ('Note','Email','Call','Meeting','LinkedIn','SMS','WhatsApp','Postal mail')`),
]);
