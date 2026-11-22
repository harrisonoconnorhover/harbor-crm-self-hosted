import {workspaceViewers} from './workspace-viewer-schema';
import {bigint,boolean,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,time,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import type {PortableInvite,PortableReschedule} from '../../lib/calendar/portable-meetings';
import {contacts} from './contact-schema';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';
import type {TeamTimeOff,TeamWindow} from '../../lib/calendar/team-booking';
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
  index('portable_confirmed_contact_meetings').on(t.workspaceId,t.contactId,t.createdAt).where(sql`${t.status}='scheduled'`),
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

export const teamOffers=pgTable('portable_team_availability',{
  id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  userId:text('user_id').notNull().references(()=>loginIdentities.id),
  grantId:uuid('grant_id').references(()=>workspaceViewers.id,{onDelete:'cascade',onUpdate:'cascade'}),
  windows:jsonb('windows').$type<TeamWindow[]>().notNull(),revision:integer('revision').notNull(),
  timeOff:jsonb('time_off').$type<(TeamTimeOff&{startMs:number;endMs:number})[]>().notNull().default([]),
  weeklyDays:integer('weekly_days').array(),weeklyZone:text('weekly_zone'),
  weeklyStart:time('weekly_start'),weeklyEnd:time('weekly_end'),weeklyLive:boolean('weekly_live').notNull().default(false),
  lastAssignedAt:bigint('last_assigned_at',{mode:'number'}),
},t=>[uniqueIndex('portable_team_offer_member').on(t.workspaceId,t.userId),
  check('portable_team_time_off_limit',sql`jsonb_typeof(${t.timeOff})='array' AND jsonb_array_length(${t.timeOff})<=24`),
  check('portable_team_weekly_hours',sql`(
    num_nonnulls(${t.weeklyDays},${t.weeklyZone},${t.weeklyStart},${t.weeklyEnd})=0 AND NOT ${t.weeklyLive}
  ) OR (
    num_nonnulls(${t.weeklyDays},${t.weeklyZone},${t.weeklyStart},${t.weeklyEnd})=4
    AND cardinality(${t.weeklyDays}) BETWEEN 1 AND 7 AND ${t.weeklyDays} <@ ARRAY[1,2,3,4,5,6,7]
    AND length(${t.weeklyZone}) BETWEEN 1 AND 100
    AND ${t.weeklyEnd}-${t.weeklyStart}
      + CASE WHEN ${t.weeklyEnd}<${t.weeklyStart} THEN interval '24 hours' ELSE interval '0' END
      BETWEEN interval '15 minutes' AND interval '8 hours'
  )`),
  check('portable_team_offer_limits',sql`${t.revision}>0 AND jsonb_typeof(${t.windows})='array' AND jsonb_array_length(${t.windows})<=12`)]);

export const teamPages=pgTable('portable_team_calendars',{
  id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  title:text('title').notNull(),mode:text('mode').$type<'collective'|'rotation'>().notNull(),
  publicEnabled:boolean('public_enabled').notNull().default(false),closed:boolean('closed').notNull().default(false),
  duration:integer('duration').notNull(),hosts:uuid('hosts').array().notNull(),
},t=>[index('portable_team_calendar_workspace').on(t.workspaceId),
  check('portable_team_calendar_limits',sql`length(${t.title}) BETWEEN 1 AND 100 AND ${t.mode} IN ('collective','rotation')
    AND ${t.duration} IN (15,30,60) AND cardinality(${t.hosts}) BETWEEN 1 AND 12`)]);

// Bookings survive retiring a public link or removing a member's access.
export const teamBookings=pgTable('portable_team_bookings',{
  id:uuid('id').notNull(),workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  pageId:uuid('page_id').notNull(),title:text('title').notNull(),email:text('email').notNull(),
  start:bigint('start_at',{mode:'number'}).notNull(),end:bigint('end_at',{mode:'number'}).notNull(),
  cancelled:boolean('cancelled').notNull().default(false),
},t=>[primaryKey({columns:[t.workspaceId,t.id]}),index('portable_team_booking_upcoming').on(t.workspaceId,t.start),
  check('portable_team_booking_span',sql`${t.end}>${t.start}`)]);
export const teamAttendees=pgTable('portable_team_booking_hosts',{
  workspaceId:uuid('workspace_id').notNull(),bookingId:uuid('booking_id').notNull(),
  userId:text('user_id').notNull().references(()=>loginIdentities.id),
},t=>[primaryKey({columns:[t.workspaceId,t.bookingId,t.userId]}),
  foreignKey({columns:[t.workspaceId,t.bookingId],foreignColumns:[teamBookings.workspaceId,teamBookings.id]}),
  index('portable_booked_host').on(t.userId,t.workspaceId,t.bookingId)]);
