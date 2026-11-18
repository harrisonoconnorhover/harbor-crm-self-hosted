import {sql} from 'drizzle-orm';
import {integer,jsonb,pgTable,primaryKey,text,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import type {PropertyOrganization} from '../../lib/property-groups';
import type {PortableCustomPropertyKind,PortableCustomPropertyType} from '../../lib/portable-custom-properties';
import {privateWorkspaces} from './workspace-schema';

export const portableCustomProperties=pgTable('portable_custom_properties',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  kind:text('kind').$type<PortableCustomPropertyKind>().notNull(),
  id:uuid('id').notNull(),
  label:text('label').notNull(),
  type:text('type').$type<PortableCustomPropertyType>().notNull(),
  options:jsonb('options').$type<string[]>().notNull(),
  revision:integer('revision').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.kind,table.id]}),
  uniqueIndex('portable_custom_property_label').on(table.workspaceId,table.kind,sql`lower(${table.label})`),
]);

export const portablePropertyOrganizations=pgTable('portable_property_organizations',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  kind:text('kind').$type<PortableCustomPropertyKind>().notNull(),
  revision:integer('revision').notNull(),
  config:jsonb('config').$type<PropertyOrganization>().notNull(),
},table=>[primaryKey({columns:[table.workspaceId,table.kind]})]);
