import {bigint,check,foreignKey,index,integer,pgTable,primaryKey,text,uuid} from 'drizzle-orm/pg-core';
import {sql,type SQLWrapper} from 'drizzle-orm';
import {wordSearchDocument} from './search-index';
import type {PortableOutreach} from '../../lib/portable-contact-activities';
import type {AircallAsset} from '../../lib/aircall-activity';
import {privateWorkspaces} from './workspace-schema';
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
  index('portable_contact_call_summary_search').using('gin',wordSearchDocument(table.summary)).where(sql`${table.kind} = 'Call'`),
  primaryKey({columns:[table.workspaceId,table.id]}),
  foreignKey({columns:[table.workspaceId,table.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  index('portable_contact_activity_order').on(table.workspaceId,table.contactId,table.occurredAt,table.id),
  check('portable_contact_activity_kind',sql`${table.kind} IN ('Note','Email','Call','Meeting','LinkedIn','SMS','WhatsApp','Postal mail')`),
]);


export const portableAircallAssets=pgTable('portable_aircall_assets',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  activityId:uuid('activity_id').notNull(),
  asset:text('asset').$type<AircallAsset>().notNull(),
},r=>[
  primaryKey({columns:[r.workspaceId,r.activityId,r.asset]}),
  check('aircall_asset_type',sql`${r.asset} IN ('recording','transcript')`),
]);

export function reportedAircallAssets(workspace:SQLWrapper,id:SQLWrapper){
  const a=portableAircallAssets;
  return sql<AircallAsset[]|null>`(SELECT jsonb_agg(${a.asset} ORDER BY ${a.asset}) FROM ${a}
    WHERE ${a.workspaceId}=${workspace} AND ${a.activityId}=${id})`;
}
