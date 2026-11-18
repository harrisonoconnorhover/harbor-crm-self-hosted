import {bigint,check,foreignKey,integer,pgTable,text,unique,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {loginIdentities} from './identity-schema';
import {portableContactActivities} from './portable-contact-activity-schema';
import {portableRecordActivities} from './portable-record-activity-schema';

export const portableActivityHistory=pgTable('portable_activity_history',{
  id:uuid('id').defaultRandom().primaryKey(),
  workspaceId:uuid('workspace_id').notNull(),
  contactActivityId:uuid('contact_activity_id'),
  recordActivityId:uuid('record_activity_id'),
  revision:integer('revision').notNull(),
  editorId:text('editor_id').notNull().references(()=>loginIdentities.id),
  editorName:text('editor_name').notNull(),
  editedAt:bigint('edited_at',{mode:'number'}).notNull(),
  previousAt:bigint('previous_at',{mode:'number'}).notNull(),
  previousSummary:text('previous_summary').notNull(),
  occurredAt:bigint('occurred_at',{mode:'number'}).notNull(),
  summary:text('summary').notNull(),
},table=>[
  foreignKey({name:'portable_activity_history_contact_fk',columns:[table.workspaceId,table.contactActivityId],
    foreignColumns:[portableContactActivities.workspaceId,portableContactActivities.id]}).onDelete('cascade'),
  foreignKey({name:'portable_activity_history_record_fk',columns:[table.workspaceId,table.recordActivityId],
    foreignColumns:[portableRecordActivities.workspaceId,portableRecordActivities.id]}).onDelete('cascade'),
  unique('portable_activity_history_contact_revision').on(table.workspaceId,table.contactActivityId,table.revision),
  unique('portable_activity_history_record_revision').on(table.workspaceId,table.recordActivityId,table.revision),
  check('portable_activity_history_home',sql`num_nonnulls(${table.contactActivityId},${table.recordActivityId})=1`),
]);
