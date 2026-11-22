import {sql} from 'drizzle-orm';
import {boolean,check,foreignKey,integer,jsonb,pgTable,primaryKey,text,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import type {PropertyOrganization} from '../../lib/property-groups';
import type {PortableCustomPropertyKind,PortableCustomPropertyType} from '../../lib/portable-custom-properties';
import {privateWorkspaces} from './workspace-schema';

import {workspaceTeams} from './workspace-team-schema';

export const portableCustomProperties=pgTable('portable_custom_properties',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  kind:text('kind').$type<PortableCustomPropertyKind>().notNull(),
  id:uuid('id').notNull(),
  label:text('label').notNull(),
  type:text('type').$type<PortableCustomPropertyType>().notNull(),
  restricted:boolean('restricted').notNull().default(false),
  visibleTeamId:uuid('visible_team_id'),
  options:jsonb('options').$type<string[]>().notNull(),
  revision:integer('revision').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.kind,table.id]}),
  foreignKey({name:'portable_property_visible_team',columns:[table.workspaceId,table.visibleTeamId],foreignColumns:[workspaceTeams.workspaceId,workspaceTeams.id]}),
  check('portable_record_property_audience',sql`(NOT ${table.restricted} AND ${table.visibleTeamId} IS NULL) OR (${table.restricted} AND ${table.kind} IN ('contacts','companies','deals'))`),
  uniqueIndex('portable_custom_property_label').on(table.workspaceId,table.kind,sql`lower(${table.label})`),
]);

export const portablePropertyOrganizations=pgTable('portable_property_organizations',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  kind:text('kind').$type<PortableCustomPropertyKind>().notNull(),
  revision:integer('revision').notNull(),
  config:jsonb('config').$type<PropertyOrganization>().notNull(),
},table=>[primaryKey({columns:[table.workspaceId,table.kind]})]);

export const portableStandardPropertyAccess=pgTable('portable_standard_property_access',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  kind:text('kind').$type<PortableCustomPropertyKind>().notNull(),
  id:text('id').notNull(),
  restricted:boolean('restricted').notNull(),
  visibleTeamId:uuid('visible_team_id'),
  revision:integer('revision').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.kind,table.id]}),
  foreignKey({name:'portable_standard_property_visible_team',columns:[table.workspaceId,table.visibleTeamId],foreignColumns:[workspaceTeams.workspaceId,workspaceTeams.id]}),
  check('portable_standard_property_revision',sql`${table.revision} >= 1`),
  check('portable_standard_property_audience',sql`${table.restricted} OR ${table.visibleTeamId} IS NULL`),
  check('portable_standard_property_key',sql`(${table.kind}='contacts' AND ${table.id} IN ('mobilePhone','address','address2','postalCode','description','department','seniority','leadStatus','linkedinUrl','website','preferredLanguage','state','timeZone'))
    OR (${table.kind}='companies' AND ${table.id} IN ('annualRevenue','numberOfEmployees','address','address2','postalCode','description','companyType','targetAccount','icpTier','leadStatus','industry','linkedinUrl','state','timeZone','yearFounded'))
    OR (${table.kind}='deals' AND ${table.id} IN ('stage','amount','closeDate','closedWonReason','closedLostReason','nextStep','description','dealType','priority','forecastCategory'))`),
]);
