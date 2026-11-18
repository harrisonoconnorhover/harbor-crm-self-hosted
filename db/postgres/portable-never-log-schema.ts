import {pgTable,primaryKey,text,timestamp,unique,uuid} from 'drizzle-orm/pg-core';
import {privateWorkspaces} from './contact-schema';

export const portableNeverLogRules=pgTable('portable_never_log_rules',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  value:text('value').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.id]}),
  unique('portable_never_log_value').on(table.workspaceId,table.value),
]);
