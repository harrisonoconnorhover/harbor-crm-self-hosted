import {sql} from 'drizzle-orm';
import {check,foreignKey,index,integer,pgTable,primaryKey,text,timestamp,unique,uuid} from 'drizzle-orm/pg-core';
import {privateWorkspaces} from './workspace-schema';

export const webhookSubscriptions=pgTable('portable_webhook_subscriptions',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  id:uuid('id').defaultRandom().notNull(),
  destination:text('destination').notNull(),
  objects:text('objects').array().notNull(),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).defaultNow().notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  unique('portable_webhook_destination').on(table.workspaceId,table.destination),
  check('portable_webhook_destination_valid',sql`length(trim(${table.destination})) BETWEEN 1 AND 128`),
  check('portable_webhook_objects',sql`cardinality(${table.objects}) BETWEEN 1 AND 6 AND
    ${table.objects} <@ ARRAY['contacts','companies','deals','tasks','leads','tickets']::text[]`),
]);

export const webhookDeliveries=pgTable('portable_webhook_deliveries',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').defaultRandom().primaryKey(),
  subscriptionId:uuid('subscription_id').notNull(),
  objectKind:text('object_kind').notNull(),
  recordId:uuid('record_id').notNull(),
  revision:integer('revision').notNull(),
  action:text('action').notNull(),
  occurredAt:timestamp('occurred_at',{withTimezone:true,mode:'string'}).defaultNow().notNull(),
  status:text('status').default('pending').notNull(),
  attempts:integer('attempts').default(0).notNull(),
  availableAt:timestamp('available_at',{withTimezone:true,mode:'string'}).defaultNow().notNull(),
  attemptedAt:timestamp('attempted_at',{withTimezone:true,mode:'string'}),
  finishedAt:timestamp('finished_at',{withTimezone:true,mode:'string'}),
  httpStatus:integer('http_status'),
  confirmedBy:text('confirmed_by'),
},table=>[
  foreignKey({name:'portable_webhook_subscription_fk',columns:[table.workspaceId,table.subscriptionId],
    foreignColumns:[webhookSubscriptions.workspaceId,webhookSubscriptions.id]}).onDelete('cascade'),
  check('portable_webhook_delivery_event',sql`${table.revision}>0 AND
    ${table.objectKind} IN ('contacts','companies','deals','tasks','leads','tickets') AND
    ${table.action} IN ('created','updated','archived','restored','deleted')`),
  check('portable_webhook_delivery_state',sql`${table.status} IN ('pending','sending','delivered','failed','uncertain') AND
    ${table.attempts}>=0 AND (${table.httpStatus} IS NULL OR ${table.httpStatus} BETWEEN 100 AND 599)`),
  check('portable_webhook_owner_confirmation',sql`${table.confirmedBy} IS NULL OR
    (${table.status}='delivered' AND ${table.finishedAt} IS NOT NULL AND ${table.attempts}>0)`),
  index('portable_webhook_due').on(table.workspaceId,table.subscriptionId,table.availableAt,table.id).where(sql`${table.status}='pending'`),
  index('portable_webhook_last_attempt').on(table.workspaceId,table.attemptedAt.desc()).where(sql`${table.attemptedAt} IS NOT NULL`),
  index('portable_webhook_sending').on(table.attemptedAt,table.id).where(sql`${table.status}='sending'`),
  index('portable_webhook_delivered').on(table.finishedAt,table.id).where(sql`${table.status}='delivered'`),
  index('portable_webhook_record_history').on(table.workspaceId,table.objectKind,table.recordId,table.occurredAt.desc(),table.id.desc()),
  index('portable_webhook_recent').on(table.workspaceId,table.occurredAt.desc(),table.id.desc()),
]);
