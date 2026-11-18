import {foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import type {PortableQuoteAction,PortableQuoteDisposition} from '../../lib/portable-quotes';
import type {Quote,QuoteData,QuoteSnapshot} from '../../lib/quotes';
import {deals} from './deal-schema';
import {loginIdentities} from './identity-schema';

export const portableQuotes=pgTable('portable_quotes',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  dealId:uuid('deal_id').notNull(),
  dealCreatedAt:timestamp('deal_created_at',{withTimezone:true,mode:'string'}).notNull(),
  dealName:text('deal_name').notNull(),
  revision:integer('revision').notNull(),
  creationKey:text('creation_key').notNull(),
  number:integer('number'),
  version:integer('published_version'),
  publishedAt:timestamp('published_at',{withTimezone:true,mode:'string'}),
  disposition:text('disposition').$type<PortableQuoteDisposition>(),
  acceptance:jsonb('acceptance').$type<NonNullable<Quote['acceptance']>>(),
  data:jsonb('data').$type<QuoteData>().notNull(),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({columns:[table.workspaceId,table.dealId],foreignColumns:[deals.workspaceId,deals.id]}),
  index('portable_quotes_deal_id').on(table.workspaceId,table.dealId,table.id),
  uniqueIndex('portable_quote_workspace_number').on(table.workspaceId,table.number),
]);

export const portableQuoteEvents=pgTable('portable_quote_events',{
  workspaceId:uuid('workspace_id').notNull(),
  quoteId:uuid('quote_id').notNull(),
  revision:integer('revision').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  action:text('action').$type<PortableQuoteAction>().notNull(),
  note:text('note'),
  at:timestamp('occurred_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.quoteId,table.revision]}),
  foreignKey({columns:[table.workspaceId,table.quoteId],foreignColumns:[portableQuotes.workspaceId,portableQuotes.id]}),
]);

export const portableQuoteVersions=pgTable('portable_quote_versions',{
  workspaceId:uuid('workspace_id').notNull(),
  quoteId:uuid('quote_id').notNull(),
  version:integer('version').notNull(),
  publishedAt:timestamp('published_at',{withTimezone:true,mode:'string'}).notNull(),
  snapshot:jsonb('snapshot').$type<QuoteSnapshot>().notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.quoteId,table.version]}),
  foreignKey({name:'portable_quote_versions_quote_fk',columns:[table.workspaceId,table.quoteId],
    foreignColumns:[portableQuotes.workspaceId,portableQuotes.id]}),
]);
