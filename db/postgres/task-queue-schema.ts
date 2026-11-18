import {integer,pgTable,primaryKey,text,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {privateWorkspaces} from './workspace-schema';

export const portableTaskQueues=pgTable('portable_task_queues',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  name:text('name').notNull(),
  revision:integer('revision').notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  uniqueIndex('portable_task_queues_name').on(table.workspaceId,sql`lower(${table.name})`),
]);
