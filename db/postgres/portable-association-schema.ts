import {sql} from 'drizzle-orm';
import {check,index,jsonb,pgTable,primaryKey,text,unique,uuid} from 'drizzle-orm/pg-core';
import type {PortableRecordKind} from '../../lib/portable-records';
import {privateWorkspaces} from './workspace-schema';

export const portableAssociations=pgTable('portable_associations',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  firstKind:text('first_kind').$type<PortableRecordKind>().notNull(),
  firstId:uuid('first_id').notNull(),
  secondKind:text('second_kind').$type<PortableRecordKind>().notNull(),
  secondId:uuid('second_id').notNull(),
  labels:jsonb('labels').$type<string[]>().notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  unique('portable_association_pair').on(t.workspaceId,t.firstKind,t.firstId,t.secondKind,t.secondId),
  index('portable_association_first').on(t.workspaceId,t.firstKind,t.firstId,t.id),
  index('portable_association_second').on(t.workspaceId,t.secondKind,t.secondId,t.id),
  check('portable_association_kinds',sql`${t.firstKind} IN ('companies','contacts','deals') AND ${t.secondKind} IN ('companies','contacts','deals')`),
  check('portable_association_order',sql`(${t.firstKind},${t.firstId}) < (${t.secondKind},${t.secondId})`),
]);
