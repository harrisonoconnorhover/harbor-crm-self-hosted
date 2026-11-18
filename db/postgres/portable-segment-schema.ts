import {sql} from 'drizzle-orm';
import {check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import type {PortableSegmentDefinition} from '../../lib/portable-segments';
import {contacts} from './contact-schema';
import {privateWorkspaces} from './workspace-schema';

export const portableSegments=pgTable('portable_segments',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  revision:integer('revision').notNull(),
  mode:text('mode').$type<PortableSegmentDefinition['mode']>().notNull().default('active'),
  staticGeneration:uuid('static_generation'),
  name:text('name').notNull(),
  description:text('description').notNull(),
  criteria:jsonb('criteria').$type<PortableSegmentDefinition['criteria']>().notNull(),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  check('portable_segments_positive_revision',sql`${table.revision} > 0`),
  check('portable_segments_mode_identity',sql`
    (${table.mode} = 'active' AND ${table.staticGeneration} IS NULL)
    OR (${table.mode} = 'static' AND ${table.staticGeneration} IS NOT NULL)
  `),
  index('portable_segments_active_picker').on(table.workspaceId,table.id).where(sql`${table.mode} = 'active'`),
]);

export const portableSegmentMembers=pgTable('portable_segment_members',{
  workspaceId:uuid('workspace_id').notNull(),
  segmentId:uuid('segment_id').notNull(),
  contactId:uuid('contact_id').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.segmentId,table.contactId]}),
  foreignKey({name:'portable_segment_members_segment_fk',columns:[table.workspaceId,table.segmentId],
    foreignColumns:[portableSegments.workspaceId,portableSegments.id]}).onDelete('cascade'),
  foreignKey({name:'portable_segment_members_contact_fk',columns:[table.workspaceId,table.contactId],
    foreignColumns:[contacts.workspaceId,contacts.id]}).onDelete('cascade'),
  index('portable_segment_members_contact').on(table.workspaceId,table.contactId),
]);

// Keep receipts through deletion so a reused segment UUID cannot replay an old mutation.
export const portableSegmentMembershipReceipts=pgTable('portable_segment_membership_receipts',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  requestId:uuid('request_id').notNull(),
  segmentId:uuid('segment_id').notNull(),
  staticGeneration:uuid('static_generation').notNull(),
  fingerprint:text('fingerprint').notNull(),
  revision:integer('revision').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.requestId]}),
  check('portable_segment_membership_receipts_revision',sql`${table.revision} > 1`),
]);
