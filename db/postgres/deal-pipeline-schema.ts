import {check,foreignKey,index,integer,jsonb,pgTable,primaryKey,text,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import type {PipelineStage} from '../../lib/portable-deal-pipelines';
import type {StagePropertyItems} from '../../lib/stage-property-rules';
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
