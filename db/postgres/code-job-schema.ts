import {foreignKey,jsonb,pgTable,primaryKey,uuid} from 'drizzle-orm/pg-core';
import type {PortableCodeOutput,PortableCodePayload} from '../../lib/portable-workflow-code';
import {portableJobs} from './job-schema';

export const portableCodeJobs=pgTable('portable_code_jobs',{
  workspaceId:uuid('workspace_id').notNull(),
  jobId:uuid('job_id').notNull(),
  payload:jsonb('payload').$type<PortableCodePayload>().notNull(),
  result:jsonb('result').$type<PortableCodeOutput>(),
},table=>[
  primaryKey({columns:[table.workspaceId,table.jobId]}),
  foreignKey({name:'portable_code_job_fk',columns:[table.workspaceId,table.jobId],foreignColumns:[portableJobs.workspaceId,portableJobs.id]}),
]);
