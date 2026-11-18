import {bigint,index,pgTable,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import {loginIdentities} from './identity-schema';

export const privateWorkspaces=pgTable('private_workspaces',{
  id:uuid('id').primaryKey(),
  ownerId:text('owner_id').notNull().unique().references(()=>loginIdentities.id),
  lastJobClaimAt:bigint('last_job_claim_at',{mode:'number'}),
  lastTaskRepeatAt:timestamp('last_task_repeat_at',{withTimezone:true,mode:'string'}),
  lastFormNotePromotionAt:timestamp('last_form_note_promotion_at',{withTimezone:true,mode:'string'}),
},table=>[
  index('private_workspace_task_repeat_order').on(table.lastTaskRepeatAt.asc().nullsFirst(),table.id),
  index('private_workspace_form_note_order').on(table.lastFormNotePromotionAt.asc().nullsFirst(),table.id),
]);
