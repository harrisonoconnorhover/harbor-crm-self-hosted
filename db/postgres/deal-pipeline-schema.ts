import {bigint,check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,unique,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import type {PipelineStage} from '../../lib/portable-deal-pipelines';
import type {StagePropertyItems} from '../../lib/stage-property-rules';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

export const dealPipelines=pgTable('deal_pipelines',{
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  id:uuid('id').notNull(),
  name:text('name').notNull(),
  revision:integer('revision').notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  uniqueIndex('deal_pipelines_workspace_name').on(t.workspaceId,sql`lower(${t.name})`),
]);

export const dealPipelineStages=pgTable('deal_pipeline_stages',{
  workspaceId:uuid('workspace_id').notNull(),
  pipelineId:uuid('pipeline_id').notNull(),
  id:uuid('id').notNull(),
  name:text('name').notNull(),
  outcome:text('outcome').$type<PipelineStage['outcome']>().notNull(),
  position:integer('position').notNull(),
  probability:integer('probability'),
  requiredProperties:jsonb('required_properties').$type<StagePropertyItems>().notNull().default([]),
},t=>[
  primaryKey({columns:[t.workspaceId,t.pipelineId,t.id]}),
  foreignKey({columns:[t.workspaceId,t.pipelineId],foreignColumns:[dealPipelines.workspaceId,dealPipelines.id]}),
  index('deal_pipeline_stage_order').on(t.workspaceId,t.pipelineId,t.position),
  check('deal_pipeline_stage_outcome',sql`${t.outcome} IN ('open','won','lost')`),
]);


export const forecastGoals=pgTable('portable_forecast_goals',{
  id:uuid('id').primaryKey().defaultRandom(),
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id),
  pipelineId:uuid('pipeline_id'),
  ownerId:text('owner_id').references(()=>loginIdentities.id),
  month:text('month').notNull(),
  period:text('period').$type<'month'|'quarter'>().notNull().default('month'),
  amountCents:bigint('amount_cents',{mode:'number'}),
  revision:integer('revision').notNull(),
},t=>[
  unique('forecast_goal_period_scope').on(t.workspaceId,t.month,t.period,t.pipelineId,t.ownerId).nullsNotDistinct(),
  foreignKey({name:'forecast_goal_pipeline',columns:[t.workspaceId,t.pipelineId],foreignColumns:[dealPipelines.workspaceId,dealPipelines.id]}),
  check('forecast_goal_period',sql`${t.period} IN ('month','quarter')`),
  check('forecast_goal_month',sql`${t.month} ~ '^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$'`),
  check('forecast_goal_value',sql`${t.amountCents} BETWEEN 0 AND 100000000000000`),
  check('forecast_goal_revision',sql`${t.revision}>0`),
]);
