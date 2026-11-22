import {sql} from 'drizzle-orm';
import {bigint,bigserial,boolean,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,unique,uuid} from 'drizzle-orm/pg-core';
import {privateWorkspaces} from './workspace-schema';
import {leadInquiries} from './lead-form-schema';

export const trackingSites=pgTable('portable_tracking_sites',{
  id:uuid('id').primaryKey(),
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  name:text('name').notNull(),origin:text('origin').notNull(),enabled:boolean('enabled').notNull().default(false),
  revision:integer('revision').notNull().default(1),
},t=>[
  unique('tracking_site_workspace').on(t.workspaceId,t.id),
  unique('tracking_site_origin').on(t.workspaceId,t.origin),
  check('tracking_site_definition',sql`${t.revision}>0 AND length(${t.name}) BETWEEN 1 AND 100 AND length(${t.origin}) BETWEEN 1 AND 2048`),
]);

export type JourneyTouch={id:string;at:number;path:string;source:string;medium:string;campaign:string};
export const pageEvents=pgTable('portable_page_events',{
  siteId:uuid('site_id').notNull().references(()=>trackingSites.id),
  eventId:uuid('event_id').notNull(),sequence:bigserial('sequence',{mode:'number'}).notNull(),
  visitorHash:text('visitor_hash').notNull(),at:bigint('at',{mode:'number'}).notNull(),
  path:text('path').notNull(),source:text('source').notNull(),medium:text('medium').notNull(),campaign:text('campaign').notNull(),
},t=>[
  primaryKey({columns:[t.siteId,t.eventId]}),
  index('page_event_visitor_journey').on(t.siteId,t.visitorHash,t.at,t.sequence),
  index('page_event_site_period').on(t.siteId,t.at),index('page_event_expiry').on(t.at),
  check('page_event_valid',sql`${t.visitorHash} ~ '^[0-9a-f]{64}$' AND ${t.at}>0 AND left(${t.path},1)='/' AND length(${t.path})<=1024
    AND length(${t.source}) BETWEEN 1 AND 256 AND length(${t.medium})<=256 AND length(${t.campaign})<=256`),
]);

// Store credit and a bounded, ordered path when the inquiry commits. Later visits and raw event cleanup
// cannot change the meaning of a previously attributed conversion. No persistent visitor key is needed here.
export const formConversions=pgTable('portable_form_conversions',{
  workspaceId:uuid('workspace_id').notNull(),inquiryId:uuid('inquiry_id').notNull(),siteId:uuid('site_id').notNull(),
  convertedAt:bigint('converted_at',{mode:'number'}).notNull(),total:integer('total').notNull(),
  firstSource:text('first_source').notNull(),lastSource:text('last_source').notNull(),
  utmCounts:jsonb('utm_counts').$type<{medium:Record<string,number>;campaign:Record<string,number>}>(),
  counts:jsonb('counts').$type<Record<string,number>>().notNull(),path:jsonb('path').$type<JourneyTouch[]>().notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.inquiryId]}),
  foreignKey({name:'form_conversion_site',columns:[t.workspaceId,t.siteId],foreignColumns:[trackingSites.workspaceId,trackingSites.id]}),
  foreignKey({name:'form_conversion_inquiry',columns:[t.workspaceId,t.inquiryId],foreignColumns:[leadInquiries.workspaceId,leadInquiries.id]}).onDelete('cascade'),
  index('form_conversion_site_period').on(t.workspaceId,t.siteId,t.convertedAt),
  index('form_conversion_workspace_period').on(t.workspaceId,t.convertedAt,t.inquiryId),
  index('form_conversion_expiry').on(t.convertedAt),
  check('form_conversion_utm_counts',sql`${t.utmCounts} IS NULL OR (
    jsonb_typeof(${t.utmCounts}->'medium') IS NOT DISTINCT FROM 'object' AND
    jsonb_typeof(${t.utmCounts}->'campaign') IS NOT DISTINCT FROM 'object')`),
  check('form_conversion_valid',sql`${t.total}>0 AND ${t.convertedAt}>0 AND jsonb_typeof(${t.counts})='object'
    AND jsonb_typeof(${t.path})='array' AND jsonb_array_length(${t.path})=least(100,${t.total})`),
]);
