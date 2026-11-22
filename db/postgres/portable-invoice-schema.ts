import {sql} from 'drizzle-orm';
import {commerceSearchIndex,invoiceSearchFields} from './commerce-search';
import {bigint,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import type {InvoiceData,InvoiceSnapshot,PaymentData} from '../../lib/invoices';
import type {PortableInvoiceAction} from '../../lib/portable-invoices';
import {deals} from './deal-schema';
import {loginIdentities} from './identity-schema';
import {portableQuoteVersions} from './portable-quote-schema';

export const portableInvoices=pgTable('portable_invoices',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  dealId:uuid('deal_id').notNull(),
  dealCreatedAt:timestamp('deal_created_at',{withTimezone:true,mode:'string'}).notNull(),
  dealName:text('deal_name').notNull(),
  quoteId:uuid('quote_id'),
  quoteVersion:integer('quote_version'),
  sourceNote:text('source_note').notNull(),
  revision:integer('revision').notNull(),
  creationKey:text('creation_key').notNull(),
  data:jsonb('data').$type<InvoiceData>().notNull(),
  totalCents:bigint('total_cents',{mode:'number'}).notNull(),
  paidCents:bigint('paid_cents',{mode:'number'}),
  voidReason:text('void_reason'),
  number:integer('number'),
  snapshot:jsonb('snapshot').$type<InvoiceSnapshot>(),
  finalizedAt:timestamp('finalized_at',{withTimezone:true,mode:'string'}),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  commerceSearchIndex('portable_invoices_text_search',invoiceSearchFields(table.data)),
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({name:'portable_invoice_deal_fk',columns:[table.workspaceId,table.dealId],foreignColumns:[deals.workspaceId,deals.id]}),
  foreignKey({name:'portable_invoice_quote_version_fk',columns:[table.workspaceId,table.quoteId,table.quoteVersion],
    foreignColumns:[portableQuoteVersions.workspaceId,portableQuoteVersions.quoteId,portableQuoteVersions.version]}),
  index('portable_invoices_by_deal').on(table.workspaceId,table.dealId,table.id),
  index('portable_invoices_by_quote').on(table.workspaceId,table.quoteId,table.id),
  uniqueIndex('portable_invoice_workspace_number').on(table.workspaceId,table.number),
]);

export const portableInvoiceEvents=pgTable('portable_invoice_events',{
  workspaceId:uuid('workspace_id').notNull(),
  invoiceId:uuid('invoice_id').notNull(),
  revision:integer('revision').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  action:text('action').$type<PortableInvoiceAction>().notNull(),
  note:text('note'),
  at:timestamp('occurred_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.invoiceId,table.revision]}),
  foreignKey({name:'portable_invoice_events_invoice_fk',columns:[table.workspaceId,table.invoiceId],
    foreignColumns:[portableInvoices.workspaceId,portableInvoices.id]}),
]);

export const portableInvoicePayments=pgTable('portable_invoice_payments',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  invoiceId:uuid('invoice_id').notNull(),
  creationKey:text('creation_key').notNull(),
  data:jsonb('data').$type<PaymentData>().notNull(),
  revision:integer('revision').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  unappliedAt:timestamp('unapplied_at',{withTimezone:true,mode:'string'}),
  unapplyReason:text('unapply_reason'),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({name:'portable_invoice_payment_invoice_fk',columns:[table.workspaceId,table.invoiceId],
    foreignColumns:[portableInvoices.workspaceId,portableInvoices.id]}),
  index('portable_payments_received').on(table.workspaceId,sql`(${table.data}->>'receivedOn')`,table.id),
  index('portable_invoice_payments_by_revision').on(table.workspaceId,table.invoiceId,table.revision),
]);
