import {z} from 'zod';
import {lifecycles,stages} from './crm';
import {emailContent} from './email/message';
import {pipelineKey} from './portable-deal-pipelines';
import {portableManualCodeDefinition} from './portable-workflow-code';
import {portableTaskFields} from './portable-tasks';

const id=z.string().guid("Invalid uuid");
const normalizedId=id.transform(value=>value.toLowerCase());
const revision=z.number().int().nonnegative().max(2147483646);
const actionFields={name:z.string().trim().min(1).max(80),
  delayMinutes:z.number().int().min(0).max(43_200),body:z.string().trim().min(1).max(2000)};
const noteFields={...actionFields,actionKind:z.literal('note').optional()};
const dealStageFields={pipelineId:pipelineKey,stageId:z.string().min(1).max(80)};
const validDealStage=({pipelineId,stageId}:{pipelineId:string;stageId:string})=>pipelineId==='default'?
  stages.some(stage=>stage===stageId):id.safeParse(stageId).success;
const dealStage=z.object({...noteFields,...dealStageFields,trigger:z.literal('deal_stage').optional()}).strict().refine(validDealStage);
const lifecycleFields={trigger:z.literal('contact_lifecycle'),lifecycle:z.enum(lifecycles)};
const contactLifecycle=z.object({...noteFields,...lifecycleFields}).strict();
const contactCreated=z.object({...noteFields,trigger:z.literal('contact_created')}).strict();
const contactOwnerAssigned=z.object({...noteFields,trigger:z.literal('contact_owner_assigned')}).strict();
const lifecycleGmail=z.object({...actionFields,...lifecycleFields,actionKind:z.literal('gmail'),
  subject:z.string().trim().min(1).max(200)}).strict().refine(value=>
  emailContent.safeParse({to:['contact@example.test'],subject:value.subject,body:value.body}).success);
const segmentFields={trigger:z.literal('contact_segment'),segmentId:normalizedId,
  segmentEvent:z.enum(['joined','left']).optional(),enrollment:z.enum(['once','every_event']).optional()};
const contactSegment=z.object({...noteFields,...segmentFields}).strict();
const manualContact=z.object({...noteFields,trigger:z.literal('manual_contact')}).strict();
export const portableWorkflowTaskFields=portableTaskFields.pick({name:true,taskType:true,priority:true,dueDate:true,notes:true});
const taskFields={name:actionFields.name,actionKind:z.literal('task'),delayMinutes:actionFields.delayMinutes,task:portableWorkflowTaskFields};
export const portableWorkflowTask=z.union([
  z.object({...taskFields,...dealStageFields,trigger:z.literal('deal_stage')}).strict().refine(validDealStage),
  z.object({...taskFields,trigger:z.enum(['manual_contact','contact_created','contact_owner_assigned'])}).strict(),
  z.object({...taskFields,...lifecycleFields}).strict(),
  z.object({...taskFields,...segmentFields}).strict(),
]);
export const portableManualNoteSequenceLimit=5;
export const portableManualNoteSequence=z.object({
  name:actionFields.name,trigger:z.literal('manual_contact'),actionKind:z.literal('note_sequence'),
  steps:z.array(z.object({...actionFields,id:normalizedId}).strict()).min(2).max(portableManualNoteSequenceLimit)
    .refine(steps=>new Set(steps.map(step=>step.id)).size===steps.length),
}).strict();
export type PortableManualNoteSequence=z.output<typeof portableManualNoteSequence>;
const branchNote=z.object({body:actionFields.body,delayMinutes:actionFields.delayMinutes}).strict();
const noteBranchFields={name:actionFields.name,actionKind:z.literal('note_branch'),
  lifecycle:z.enum(lifecycles),match:branchNote,otherwise:branchNote};
export const portableNoteBranch=z.union([
  z.object({...noteBranchFields,...dealStageFields,trigger:z.literal('deal_stage')}).strict().refine(validDealStage),
  z.object({...noteBranchFields,trigger:z.literal('manual_contact')}).strict(),
  z.object({...noteBranchFields,trigger:z.literal('contact_created')}).strict(),
  z.object({...noteBranchFields,trigger:z.literal('contact_owner_assigned')}).strict(),
]);

const definition=z.union([dealStage,contactLifecycle,lifecycleGmail,contactCreated,contactOwnerAssigned,contactSegment,manualContact,portableManualCodeDefinition,portableManualNoteSequence,portableNoteBranch,portableWorkflowTask]);
export const portableWorkflowAction=z.discriminatedUnion('action',[
  z.object({action:z.literal('save'),id,revision,definition}).strict(),
  z.object({action:z.literal('setEnabled'),id,revision:revision.min(1),enabled:z.boolean()}).strict(),
]);
export const portableManualWorkflowRun=z.object({action:z.literal('runContact'),id:normalizedId,workflowId:normalizedId,
  workflowRevision:revision.min(1),contactId:normalizedId}).strict();
export type PortableManualWorkflowRun=z.output<typeof portableManualWorkflowRun>;
export const portableManualBatchLimit=10;
export const portableManualWorkflowBatch=z.object({
  action:z.literal('runContactBatch'),id:normalizedId,workflowId:normalizedId,workflowRevision:revision.min(1),
  contactIds:z.array(normalizedId).min(2).max(portableManualBatchLimit)
    .refine(ids=>new Set(ids).size===ids.length).transform(ids=>ids.sort()),
}).strict();
export const portableManualBatchRead=z.object({batchId:normalizedId}).strict();
export const portableWorkflowCapacityReview=z.object({action:z.literal('reviewQueueFullRun'),id:normalizedId}).strict();
export type PortableManualWorkflowBatch=z.output<typeof portableManualWorkflowBatch>;
export const portableWorkflowCursor=z.object({at:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),id}).strict();
export const portableRunWorkflowId=normalizedId;
export const portableRunDealId=normalizedId;
export const portableRunIssue=z.literal('queue_full');
export const portableWorkflowRunRead=portableWorkflowCursor.partial().extend({
  runWorkflowId:portableRunWorkflowId.optional(),runDealId:portableRunDealId.optional(),runIssue:portableRunIssue.optional(),
})
  .refine(({at,id})=>(at===undefined)===(id===undefined));
export type PortableWorkflowCursor=z.output<typeof portableWorkflowCursor>;
export type PortableWorkflowDefinition=z.output<typeof definition>;
export type PortableWorkflowAction=z.output<typeof portableWorkflowAction>;
