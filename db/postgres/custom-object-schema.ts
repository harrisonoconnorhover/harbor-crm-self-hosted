import {sql} from 'drizzle-orm';
import {check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import type {ObjectDefinition} from '../../lib/portable-custom-objects';
import type {PortableRecordOwner} from '../../lib/portable-records';
import type {PortableCustomValues} from '../../lib/portable-custom-properties';
import {recordSearchIndex} from './search-index';
import {privateWorkspaces} from './workspace-schema';
import {contacts} from './contact-schema';
import {companies} from './company-schema';
import {deals} from './deal-schema';

export const objectTypes=pgTable('portable_object_types',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),id:uuid('id').notNull(),
  definition:jsonb('definition').$type<ObjectDefinition>().notNull(),revision:integer('revision').notNull(),
},t=>[primaryKey({columns:[t.workspaceId,t.id]}),uniqueIndex('portable_object_type_name').on(t.workspaceId,sql`lower(${t.definition}->>'name')`),
  check('object_type_definition',sql`${t.revision}>0 AND jsonb_typeof(${t.definition}->'name') IS NOT DISTINCT FROM 'string' AND jsonb_typeof(${t.definition}->'fields') IS NOT DISTINCT FROM 'array' AND length(${t.definition}->>'name') BETWEEN 1 AND 100`)]);
export const objectRecords=pgTable('portable_object_records',{
  workspaceId:uuid('workspace_id').notNull(),objectId:uuid('object_id').notNull(),id:uuid('id').notNull(),
  name:text('name').notNull(),data:jsonb('data').$type<{values:PortableCustomValues;recordOwner?:PortableRecordOwner}>().notNull(),
  revision:integer('revision').notNull(),archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),
},t=>[primaryKey({columns:[t.workspaceId,t.objectId,t.id]}),foreignKey({name:'object_record_definition',columns:[t.workspaceId,t.objectId],foreignColumns:[objectTypes.workspaceId,objectTypes.id]}),
  check('object_record_valid',sql`length(${t.name}) BETWEEN 1 AND 100 AND ${t.revision}>0 AND jsonb_typeof(${t.data}->'values') IS NOT DISTINCT FROM 'object'`),
  recordSearchIndex('object_record_property_search',sql`${t.data}->'values'`),
  index('object_record_name_search').using('gin',sql`${t.name} public.gin_trgm_ops`),
  index('object_record_active_page').on(t.workspaceId,t.objectId,t.id).where(sql`${t.archivedAt} IS NULL`)]);
export const objectLinks=pgTable('portable_object_links',{
  workspaceId:uuid('workspace_id').notNull(),objectId:uuid('object_id').notNull(),recordId:uuid('record_id').notNull(),id:uuid('id').notNull(),
  contactId:uuid('contact_id'),companyId:uuid('company_id'),dealId:uuid('deal_id'),
},t=>[primaryKey({columns:[t.workspaceId,t.id]}),index('object_link_record_page').on(t.workspaceId,t.objectId,t.recordId,t.id),
  foreignKey({name:'object_link_record',columns:[t.workspaceId,t.objectId,t.recordId],foreignColumns:[objectRecords.workspaceId,objectRecords.objectId,objectRecords.id]}).onDelete('cascade'),
  foreignKey({name:'object_link_contact',columns:[t.workspaceId,t.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}).onDelete('cascade'),
  foreignKey({name:'object_link_company',columns:[t.workspaceId,t.companyId],foreignColumns:[companies.workspaceId,companies.id]}).onDelete('cascade'),
  foreignKey({name:'object_link_deal',columns:[t.workspaceId,t.dealId],foreignColumns:[deals.workspaceId,deals.id]}).onDelete('cascade'),
  check('object_link_one_target',sql`num_nonnulls(${t.contactId},${t.companyId},${t.dealId})=1`),
  ...[t.contactId,t.companyId,t.dealId].map(column=>uniqueIndex('object_link_'+column.name).on(t.workspaceId,column,t.objectId,t.recordId).where(sql`${column} IS NOT NULL`)),
]);

// An undirected pair has one stored representation, including links within one type.
export const customRecordLinks=pgTable('portable_custom_record_links',{
  workspaceId:uuid('workspace_id').notNull(),id:uuid('id').notNull(),
  leftObjectId:uuid('left_object_id').notNull(),leftRecordId:uuid('left_record_id').notNull(),
  rightObjectId:uuid('right_object_id').notNull(),rightRecordId:uuid('right_record_id').notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  foreignKey({name:'custom_link_left_record',columns:[t.workspaceId,t.leftObjectId,t.leftRecordId],
    foreignColumns:[objectRecords.workspaceId,objectRecords.objectId,objectRecords.id]}).onDelete('cascade'),
  foreignKey({name:'custom_link_right_record',columns:[t.workspaceId,t.rightObjectId,t.rightRecordId],
    foreignColumns:[objectRecords.workspaceId,objectRecords.objectId,objectRecords.id]}).onDelete('cascade'),
  check('custom_link_order',sql`(${t.leftObjectId},${t.leftRecordId}) < (${t.rightObjectId},${t.rightRecordId})`),
  uniqueIndex('custom_link_pair').on(t.workspaceId,t.leftObjectId,t.leftRecordId,t.rightObjectId,t.rightRecordId),
  index('custom_link_left_page').on(t.workspaceId,t.leftObjectId,t.leftRecordId,t.id),
  index('custom_link_right_page').on(t.workspaceId,t.rightObjectId,t.rightRecordId,t.id),
]);
