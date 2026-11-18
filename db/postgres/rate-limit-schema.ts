import {check,index,integer,pgTable,primaryKey,text} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';

export type BudgetScope='login_start'|'login_callback'|'api_read'|'api_write'|'public_form';

export const requestBudgets=pgTable('portable_request_budgets',{
  scope:text('scope').$type<BudgetScope>().notNull(),
  subject:text('subject').notNull(),
  minute:integer('minute').notNull(),
  used:integer('used').notNull(),
},t=>[
  primaryKey({columns:[t.scope,t.subject]}),
  check('portable_request_budget_scope',sql`
    (${t.scope} IN ('login_start','login_callback') AND ${t.subject}='')
    OR (${t.scope} IN ('api_read','api_write','public_form') AND ${t.subject}<>'')
  `),
]);

export const loginAttemptUses=pgTable('portable_login_attempt_uses',{
  stateHash:text('state_hash').primaryKey(),
  expiresMinute:integer('expires_minute').notNull(),
},t=>[index('portable_login_attempt_expiry').on(t.expiresMinute)]);
