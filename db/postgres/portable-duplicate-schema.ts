import {sql} from 'drizzle-orm';
import {check,index,pgTable,primaryKey,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

// A dismissed duplicate pair; record_a sorts before record_b.
export const portableDuplicateDismissals=pgTable('portable_duplicate_dismissals',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  kind:text('kind').$type<'contacts'|'companies'>().notNull(),
  recordA:uuid('record_a').notNull(),
  recordB:uuid('record_b').notNull(),
  actorId:text('actor_id').notNull().references(()=>loginIdentities.id),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.kind,table.recordA,table.recordB]}),
  index('portable_duplicate_dismissal_kind').on(table.workspaceId,table.kind),
  check('portable_duplicate_dismissal_order',sql`${table.recordA}<${table.recordB}`),
  check('portable_duplicate_dismissal_kind',sql`${table.kind} IN ('contacts','companies')`),
]);
