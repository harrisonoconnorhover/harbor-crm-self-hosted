import {bigint,boolean,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,unique,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import type {LeadFormReviewReason,PortableLeadFormDefinition,PortableLeadFormPayload} from '../../lib/portable-lead-forms';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

export const leadForms=pgTable('portable_lead_forms',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').primaryKey(),
  revision:integer('revision').notNull(),
  definition:jsonb('definition').$type<PortableLeadFormDefinition>().notNull(),
},t=>[unique('portable_lead_form_workspace_id').on(t.workspaceId,t.id)]);

// Activation is deliberately left out of recovery bundles.
export const leadFormActivations=pgTable('portable_lead_form_activations',{
  formId:uuid('form_id').primaryKey().references(()=>leadForms.id),
});

export const leadInquiries=pgTable('portable_lead_inquiries',{
  workspaceId:uuid('workspace_id').notNull(),
  id:uuid('id').notNull(),
  formId:uuid('form_id').notNull(),
  receivedAt:bigint('received_at',{mode:'number'}).notNull(),
  payload:jsonb('payload').$type<PortableLeadFormPayload>(),
  fingerprint:text('fingerprint'),
  status:text('status').$type<'created'|'linked'|'inbox_only'|'needs_review'|'removed'>().notNull(),
  routeLeadRevision:integer('route_lead_revision'),
  reviewReason:text('review_reason').$type<LeadFormReviewReason>(),
  contactId:uuid('contact_id'),
  timelineNoteId:uuid('timeline_note_id'),
  removedAt:bigint('removed_at',{mode:'number'}),
  handled:boolean('handled').notNull().default(false),
  triageRevision:integer('triage_revision').notNull().default(0),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  foreignKey({columns:[t.workspaceId,t.formId],foreignColumns:[leadForms.workspaceId,leadForms.id]}),
  index('portable_lead_inquiries_by_day').on(t.workspaceId,t.receivedAt),
  index('portable_lead_inquiries_by_form').on(t.workspaceId,t.formId,t.receivedAt,t.id),
  index('portable_lead_inquiries_search').using('gin',
    sql`(${t.payload}->>'name') public.gin_trgm_ops`,sql`(${t.payload}->>'email') public.gin_trgm_ops`)
    .where(sql`${t.status} <> 'removed'`),
  index('portable_lead_inquiries_open_page').on(t.workspaceId,t.receivedAt,t.id)
    .where(sql`NOT ${t.handled} AND ${t.status} <> 'removed'`),
  index('portable_lead_inquiries_contact_timeline').on(t.workspaceId,t.contactId,t.receivedAt,t.timelineNoteId)
    .where(sql`${t.timelineNoteId} IS NOT NULL`),
]);

// One payload-free automation receipt per accepted inquiry. Admission later uses the same job ID.
export const leadFormNoteSources=pgTable('portable_lead_form_note_sources',{
  workspaceId:uuid('workspace_id').notNull(),
  inquiryId:uuid('inquiry_id').notNull(),
  formId:uuid('form_id').notNull(),
  formRevision:integer('form_revision').notNull(),
  contactId:uuid('contact_id'),
  ownerId:text('owner_id').notNull().references(()=>loginIdentities.id),
  jobId:uuid('job_id').notNull(),
  state:text('state').$type<'awaiting_contact'|'waiting'|'queued'|'skipped'>().notNull(),
  nextAt:bigint('next_at',{mode:'number'}),
  retryAt:bigint('retry_at',{mode:'number'}),
  issue:text('issue'),
},t=>[
  primaryKey({columns:[t.workspaceId,t.inquiryId]}),
  foreignKey({name:'portable_lead_form_note_source_inquiry_fk',columns:[t.workspaceId,t.inquiryId],
    foreignColumns:[leadInquiries.workspaceId,leadInquiries.id]}),
  foreignKey({name:'portable_lead_form_note_source_form_fk',columns:[t.workspaceId,t.formId],
    foreignColumns:[leadForms.workspaceId,leadForms.id]}),
  unique('portable_lead_form_note_source_job').on(t.workspaceId,t.jobId),
  index('portable_lead_form_note_source_pending').on(t.workspaceId,t.formId)
    .where(sql`${t.state} IN ('awaiting_contact','waiting')`),
  index('portable_lead_form_note_source_ready').on(t.nextAt,t.workspaceId,t.inquiryId).where(sql`${t.state}='waiting'`),
  check('portable_lead_form_note_source_state',sql`${t.state} IN ('awaiting_contact','waiting','queued','skipped')`),
  check('portable_lead_form_note_source_contact',sql`${t.state} NOT IN ('waiting','queued') OR ${t.contactId} IS NOT NULL`),
  check('portable_lead_form_note_source_due',sql`(${t.state}='waiting') = (${t.nextAt} IS NOT NULL)`),
  check('portable_lead_form_note_source_retry',sql`${t.retryAt} IS NULL OR ${t.state}='waiting'`),
]);
