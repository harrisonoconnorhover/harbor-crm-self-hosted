import {z} from 'zod';
import {lifecycles,stages} from './crm';
import {emailContent} from './email/message';
import {pipelineKey} from './portable-deal-pipelines';
import {portableManualCodeDefinition} from './portable-workflow-code';
import {portableTaskFields} from './portable-tasks';
import {supportTag} from './team-inbox';
import {portableTicketStatus} from './portable-tickets';

export const maxPortableWorkflows=20;
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
const ticketFields={trigger:z.literal('ticket_status'),ticketStatus:portableTicketStatus};
const ticketStatusNote=z.object({...noteFields,...ticketFields}).strict();
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
const creationTaskFields={...taskFields,delayMinutes:z.literal(0),taskAssignee:z.enum(['workspace_owner','record_owner']).optional()};
export const portableWorkflowTask=z.union([
  z.object({...taskFields,...dealStageFields,trigger:z.literal('deal_stage')}).strict().refine(validDealStage),
  z.object({...taskFields,trigger:z.enum(['manual_contact','contact_created','contact_owner_assigned'])}).strict(),
  z.object({...taskFields,...ticketFields}).strict(),
  z.object({...creationTaskFields,trigger:z.literal('company_created')}).strict(),
  z.object({...creationTaskFields,trigger:z.enum(['custom_record_created','custom_record_owner_assigned']),objectId:normalizedId}).strict(),
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

export const workflowConditionFields=['name','email','title','city','lifecycle','dealName','dealAmount','dealCloseDate','ticketName','ticketPriority','ticketSource','ticketCategory','ticketTags'] as const;
type ConditionField=typeof workflowConditionFields[number];
export function workflowFieldAvailable(field:ConditionField,trigger:string){
  if(field==='dealName'||field==='dealAmount'||field==='dealCloseDate')return trigger==='deal_stage';
  if(field==='ticketName'||field==='ticketPriority'||field==='ticketSource'||field==='ticketCategory'||field==='ticketTags')return trigger==='ticket_status';
  return true;
}
export function workflowOperatorAvailable(field:ConditionField,operator:string){
  if(field==='ticketTags')return ['has_tag','lacks_tag','known','unknown'].includes(operator);
  if(operator==='has_tag'||operator==='lacks_tag')return false;
  const ordered=field==='dealAmount'||field==='dealCloseDate';
  if(operator==='gte'||operator==='lte')return ordered;
  return !ordered||(operator!=='contains'&&operator!=='not_contains');
}
export function validWorkflowAmount(value:string){
  const amount=Number(value);
  return /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())&&Number.isFinite(amount)&&amount<=1e12;
}
const closeDate=z.iso.date();
export const validWorkflowDate=(value:string)=>closeDate.safeParse(value).success;
const condition=z.object({
  field:z.enum(workflowConditionFields),operator:z.enum(['eq','neq','contains','not_contains','gte','lte','has_tag','lacks_tag','known','unknown']),
  value:z.string().trim().max(240),
}).strict().refine(rule=>(rule.operator==='known'||rule.operator==='unknown')===!rule.value.length,
  {message:'Enter a value for comparisons only.'}).refine(rule=>workflowOperatorAvailable(rule.field,rule.operator)&&
    (rule.field!=='dealAmount'||!rule.value||validWorkflowAmount(rule.value))&&
    (rule.field!=='dealCloseDate'||!rule.value||validWorkflowDate(rule.value))&&
    (rule.field!=='ticketTags'||!rule.value||supportTag.safeParse(rule.value).success),{message:'Choose a valid comparison for this property.'});
const pathTiming={delayMinutes:actionFields.delayMinutes,waitForLifecycle:z.enum(lifecycles).optional()};
const pathAction=z.discriminatedUnion('kind',[
  branchNote.extend({kind:z.literal('note'),...pathTiming}),
  z.object({kind:z.literal('task'),task:portableWorkflowTaskFields,...pathTiming}).strict(),
  z.object({kind:z.literal('webhook'),destination:z.string().trim().min(1).max(80),...pathTiming}).strict(),
]);
export const maxPortablePathActions=5;
export type PortablePathAction=z.output<typeof pathAction>;
const followUpAction=z.object({id:normalizedId,action:pathAction}).strict();
const outcome=z.object({id:normalizedId,name:actionFields.name,action:pathAction,
  then:z.array(followUpAction).min(1).max(maxPortablePathActions-1).optional()}).strict();
export const maxPortableConditionGroups=3;
const conditions=z.array(condition).min(1).max(4);
const groupFields={mode:z.enum(['all','any']),conditions};
const conditionalFields={name:actionFields.name,actionKind:z.literal('conditional_paths'),
  paths:z.array(outcome.extend({...groupFields,orGroups:z.array(z.object(groupFields).strict()).min(1).max(maxPortableConditionGroups-1).optional()})).min(1).max(5),
  otherwise:outcome};
export const portableConditionalPaths=z.union([
  z.object({...conditionalFields,...dealStageFields,trigger:z.literal('deal_stage')}).strict().refine(validDealStage),
  z.object({...conditionalFields,...ticketFields}).strict(),
  z.object({...conditionalFields,trigger:z.enum(['manual_contact','contact_created','contact_owner_assigned'])}).strict(),
]).refine(({trigger,paths})=>paths.every(path=>[path,...(path.orGroups??[])].every(group=>
  group.conditions.every(rule=>workflowFieldAvailable(rule.field,trigger)))),{message:'Use properties available for the enrollment trigger.'})
.refine(({paths,otherwise})=>{
  const ids=[...paths,otherwise].flatMap(path=>[path.id,...(path.then??[]).map(step=>step.id)]);
  return new Set(ids).size===ids.length;
},{message:'Each path and follow-up action needs a distinct ID.'});
export type PortableConditionalPaths=z.output<typeof portableConditionalPaths>;
const definition=z.union([dealStage,ticketStatusNote,contactLifecycle,lifecycleGmail,contactCreated,contactOwnerAssigned,contactSegment,manualContact,portableManualCodeDefinition,portableManualNoteSequence,portableNoteBranch,portableConditionalPaths,portableWorkflowTask]);
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
export const portableRunTicketId=normalizedId;
export const portableRunCompanyId=normalizedId;
export const portableRunObjectId=normalizedId;
export const portableRunCustomRecordId=normalizedId;
export const portableRunIssue=z.literal('queue_full');
export const portableWorkflowRunRead=portableWorkflowCursor.partial().extend({
  runWorkflowId:portableRunWorkflowId.optional(),runDealId:portableRunDealId.optional(),runTicketId:portableRunTicketId.optional(),
  runCompanyId:portableRunCompanyId.optional(),runObjectId:portableRunObjectId.optional(),
  runCustomRecordId:portableRunCustomRecordId.optional(),runIssue:portableRunIssue.optional(),
})
  .refine(({at,id})=>(at===undefined)===(id===undefined))
  .refine(({runObjectId,runCustomRecordId})=>Boolean(runObjectId)===Boolean(runCustomRecordId))
  .refine(({runCompanyId,runTicketId,runDealId,runObjectId})=>[runCompanyId,runTicketId,runDealId,runObjectId].filter(Boolean).length<=1);
export type PortableWorkflowCursor=z.output<typeof portableWorkflowCursor>;
export type PortableWorkflowDefinition=z.output<typeof definition>;
export type PortableWorkflowAction=z.output<typeof portableWorkflowAction>;
