import {bigint,boolean,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import type {PortableInvite,PortableReschedule} from '../../lib/calendar/portable-meetings';
import {contacts} from './contact-schema';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';
import type {CalendarSlot} from '../../lib/calendar/suggestions';

export const portablePublishedAvailability=pgTable('portable_published_availability',{
  workspaceId:uuid('workspace_id').primaryKey().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  id:uuid('id').notNull().unique(),title:text('title').notNull(),timeZone:text('time_zone').notNull(),
  slots:jsonb('slots').$type<CalendarSlot[]>().notNull(),
  allowGuestProof:boolean('allow_guest_proof').notNull().default(false),
});

export const portableGuestBookingRequests=pgTable('portable_guest_booking_requests',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  id:uuid('id').notNull(),pageId:uuid('page_id').notNull(),email:text('email').notNull(),
  start:text('start').notNull(),end:text('end').notNull(),codeHash:text('code_hash').notNull(),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),expiresAt:bigint('expires_at',{mode:'number'}).notNull(),
  verifiedAt:bigint('verified_at',{mode:'number'}),delivery:text('delivery').notNull().default('claimed'),providerId:text('provider_id'),
  statusReceipt:text('status_receipt'),
},t=>[primaryKey({columns:[t.workspaceId,t.id]}),index('portable_guest_booking_workspace_time').on(t.workspaceId,t.createdAt),
  index('portable_guest_booking_expiry').on(t.createdAt)]);
export const portableMeetings=pgTable('portable_calendar_meetings',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  contactId:uuid('contact_id').notNull(),
  ownerId:text('owner_id').notNull().references(()=>loginIdentities.id),
  accountId:text('account_id').notNull(),
  input:jsonb('input').$type<PortableInvite>().notNull(),
  start:bigint('start_at',{mode:'number'}).notNull(),
  end:bigint('end_at',{mode:'number'}).notNull(),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
  status:text('status').$type<'submitting'|'attention'|'scheduled'|'cancelling'|'cancel_attention'|'cancelled'|'rejected'>().notNull(),
  eventUrl:text('event_url'),
  cancellationStartedAt:bigint('cancellation_started_at',{mode:'number'}),
  rescheduleRevision:integer('reschedule_revision').notNull().default(0),
  rescheduledTimeZone:text('rescheduled_time_zone'),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  foreignKey({columns:[t.workspaceId,t.contactId],foreignColumns:[contacts.workspaceId,contacts.id]}),
  index('portable_calendar_meeting_history').on(t.workspaceId,t.createdAt,t.id),
  index('portable_calendar_meeting_overlap').on(t.workspaceId,t.end).where(sql`${t.status} NOT IN ('cancelled','rejected')`),
  index('portable_calendar_receipts_pending').on(t.status,sql`coalesce(${t.cancellationStartedAt},${t.createdAt})`)
    .where(sql`${t.status} IN ('submitting','attention','cancelling','cancel_attention')`),
  check('portable_calendar_meeting_status',sql`${t.status} IN ('submitting','attention','scheduled','cancelling','cancel_attention','cancelled','rejected')`),
]);

export const portableReschedules=pgTable('portable_calendar_reschedules',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  meetingId:uuid('meeting_id').notNull(),
  input:jsonb('input').$type<PortableReschedule>().notNull(),
  originalEtag:text('original_etag'),
  start:bigint('start_at',{mode:'number'}).notNull(),
  end:bigint('end_at',{mode:'number'}).notNull(),
  createdAt:bigint('created_at',{mode:'number'}).notNull(),
  status:text('status').$type<'submitting'|'attention'|'applied'|'rejected'>().notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  foreignKey({columns:[t.workspaceId,t.meetingId],foreignColumns:[portableMeetings.workspaceId,portableMeetings.id]}),
  uniqueIndex('portable_calendar_one_active_reschedule').on(t.workspaceId,t.meetingId)
    .where(sql`${t.status} IN ('submitting','attention')`),
  index('portable_calendar_reschedule_overlap').on(t.workspaceId,t.end)
    .where(sql`${t.status} IN ('submitting','attention')`),
  index('portable_calendar_reschedule_monitor').on(t.status,t.createdAt)
    .where(sql`${t.status} IN ('submitting','attention')`),
  check('portable_calendar_reschedule_status',sql`${t.status} IN ('submitting','attention','applied','rejected')`),
]);
