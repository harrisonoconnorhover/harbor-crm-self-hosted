import {z} from 'zod';
import {leadStages,lifecycles,stages,ticketPriorities,ticketStatuses} from './crm';
import {pipelineKey,type DealPipeline,type PipelineStage} from './portable-deal-pipelines';
import {portableRecordSearch} from './portable-records';
import {portableTaskStatuses} from './portable-tasks';
import {reportSchema} from './reporting';
import {standardField} from './standard-properties';

export const portableReportKinds=['contacts','companies','deals','tasks','leads','tickets'] as const;
export const portableReportGroupLabels={
  contacts:{field:'lifecycle',label:'Lifecycle stage'},
  companies:{field:'lifecycle',label:'Lifecycle stage'},
  deals:{field:'stage',label:'Deal stage'},
  tasks:{field:'status',label:'Task status'},
  leads:{field:'leadStage',label:'Lead stage'},
  tickets:{field:'ticketStatus',label:'Ticket status'},
} as const;
export const portableReportDealOutcomes={open:'Open',won:'Closed won',lost:'Closed lost'} as const;
export const portableReportFilterOptions={lifecycle:lifecycles,status:portableTaskStatuses,leadStage:leadStages,ticketStatus:ticketStatuses};
export const portableReportTicketSources=standardField('tickets','ticketSource')?.options??[];
export const portableReportTicketCategories=standardField('tickets','ticketCategory')?.options??[];
const reportFilter=z.discriminatedUnion('field',[
  z.object({field:z.literal('lifecycle'),operator:z.literal('eq'),value:z.enum(lifecycles)}).strict(),
  z.object({field:z.literal('status'),operator:z.literal('eq'),value:z.enum(portableTaskStatuses)}).strict(),
  z.object({field:z.literal('leadStage'),operator:z.literal('eq'),value:z.enum(leadStages)}).strict(),
  z.object({field:z.literal('ticketStatus'),operator:z.literal('eq'),value:z.enum(ticketStatuses)}).strict(),
  z.object({field:z.literal('closeDate'),operator:z.literal('between'),value:z.string().date(),valueTo:z.string().date()}).strict(),
]);
// One custom-property condition on Contacts, Companies or Deals.
export const portableReportCustomOperators={is:'is',contains:'contains',known:'has any value',unknown:'is empty'} as const;
const customFilter=z.object({propertyId:z.string().guid("Invalid uuid"),operator:z.enum(['is','contains','known','unknown']),
  value:z.union([z.string().trim().min(1).max(200),z.number().finite(),z.boolean()]).optional()}).strict()
  .refine(f=>(f.operator==='known'||f.operator==='unknown')===(f.value===undefined),'Enter a value for this custom property filter.');
export type PortableReportCustomFilter=z.output<typeof customFilter>;
export const portableReportGroupLimit=50;
export const portableReportExportGroupLimit=100;
export const portableReportFilename=(name:string)=>{
  const slug=name.replace(/[^a-z0-9]+/gi,'-').slice(0,60).replace(/^-+|-+$/g,'');
  return 'harbor-report-'+(slug||'results')+'.csv';
};
const id=z.string().guid("Invalid uuid");
const builtinStage=z.enum(stages);
const revision=z.number().int().positive().max(2147483646);
const calendarDate=z.string().date().refine(value=>value>='0001-01-01','Choose a date in year 0001 or later.');
const reportDateRange=z.object({from:calendarDate,through:calendarDate}).strict();

export const portableReportDefinition=reportSchema.pick({name:true,metric:true,measure:true,groupBy:true,sort:true}).extend({
  kind:z.enum(portableReportKinds),
  filter:reportFilter.optional(),
  customFilter:customFilter.optional(),
  createdDateRange:reportDateRange.refine(({from,through})=>from<=through,'Choose a create date range with the earlier date first.').optional(),
  taskDueDateRange:reportDateRange.refine(({from,through})=>from<=through,'Choose a due date range with the earlier date first.').optional(),
  taskAssigneeId:z.string().min(1).max(200).nullable().optional(),
  ticketPriority:z.enum(ticketPriorities).optional(),
  ticketSource:z.string().refine(value=>portableReportTicketSources.includes(value),'Choose a supported Ticket source.').optional(),
  ticketCategory:z.string().refine(value=>portableReportTicketCategories.includes(value),'Choose a supported Ticket category.').optional(),
  dealOutcome:z.enum(['open','won','lost']).optional(),
  dealPipelineId:pipelineKey.optional(),
  dealStageId:z.union([builtinStage,id]).optional(),
}).strict().refine(d=>
  (!d.groupBy||d.groupBy===portableReportGroupLabels[d.kind].field)&&
  (d.metric==='count'&&d.measure===''||d.kind==='deals'&&d.metric==='sum'&&d.measure==='amount'),
  'Choose a supported measure and grouping for the selected object.')
  .refine(({kind,filter,dealOutcome,dealPipelineId})=>((dealOutcome===undefined&&dealPipelineId===undefined)||kind==='deals')&&(!filter||
    (kind==='deals'?filter.field==='closeDate'&&filter.value<=filter.valueTo:
      filter.field===portableReportGroupLabels[kind].field)),
  'Choose a supported filter with an ordered date range when applicable.')
  .refine(({kind,dealPipelineId,dealStageId})=>!dealStageId||(kind==='deals'&&
    (dealPipelineId==='default'?builtinStage.safeParse(dealStageId).success:!!dealPipelineId&&id.safeParse(dealStageId).success)),
  'Choose a deal stage from the selected pipeline.')
  .refine(d=>!d.taskDueDateRange||d.kind==='tasks','A due date range is available for Tasks only.')
  .refine(d=>d.taskAssigneeId===undefined||d.kind==='tasks','An assignee filter is available for Tasks only.')
  .refine(d=>!(d.ticketPriority||d.ticketSource||d.ticketCategory)||d.kind==='tickets','Priority, source and category filters are available for Tickets only.')
  .refine(d=>!d.customFilter||['contacts','companies','deals'].includes(d.kind),'Custom property filters are available for Contacts, Companies and Deals.');
export const portableReportSearch=z.preprocess(value=>typeof value==='string'?value.trim()||undefined:value,
  portableRecordSearch.refine(value=>!value.includes('\0')).optional());
export const portableReportRead=z.union([
  z.object({id}).strict(),
  z.object({view:z.literal('library').default('library'),after:id.optional(),search:portableReportSearch,
    limit:z.coerce.number().int().min(1).max(50).default(25)}).strict(),
]);
const save=z.object({action:z.literal('report'),definition:portableReportDefinition});
export const portableReportWrite=z.union([
  save.strict(),
  save.extend({id,revision}).strict(),
  z.object({action:z.literal('preview'),definition:portableReportDefinition}).strict(),
  z.object({action:z.literal('export'),definition:portableReportDefinition}).strict(),
  z.object({action:z.literal('export'),id,revision}).strict(),
  z.object({action:z.literal('deleteReport'),id,revision}).strict(),
]);

export type PortableReportDefinition=z.output<typeof portableReportDefinition>;
export type PortableReportAssigneeOption={id:string;label:string};
export type PortableReportPipelineOption=Pick<DealPipeline,'id'|'name'>&{stages:Pick<PipelineStage,'id'|'name'>[]};
export function portableReportPipelineOptions(pipelines:DealPipeline[]):PortableReportPipelineOption[]{
  return pipelines.map(({id,name,stages})=>({id,name,stages:stages.map(({id,name})=>({id,name}))}));
}
export type PortableReportRead=z.output<typeof portableReportRead>;
export type PortableReportExport=Extract<z.output<typeof portableReportWrite>,{action:'export'}>;
export type PortableReportMutation=Exclude<z.output<typeof portableReportWrite>,{action:'preview'|'export'}>;
export type PortableSavedReport={id:string;revision:number;updatedAt:string;definition:PortableReportDefinition};
export type PortableReportPage={items:PortableSavedReport[];next:string|null};
export type PortableReportResult={total:string|null;count:string;rows:{key:string|null;label:string;count:string;value:string|null}[];
  truncated:boolean};
