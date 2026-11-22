import {z} from 'zod';
import {pipelineKey} from './portable-deal-pipelines';
import {dashboardSchema} from './reporting';
import {portableRecordSearch} from './portable-records';
import type {Kind} from './crm';
import type {PortableReportDefinition,PortableReportResult} from './portable-reports';

const id=z.string().guid("Invalid uuid").transform(value=>value.toLowerCase());
const revision=z.number().int().positive().max(2147483646);
const card=z.object({reportId:id,wide:z.boolean().default(false)}).strict();

const objectCard=z.object({objectId:id,by:z.string().guid().optional(),sum:z.string().guid().optional(),wide:z.boolean().default(false)}).strict();
export type DashboardCardSource=z.output<typeof card>|z.output<typeof objectCard>;
export function dashboardCardKey(card:DashboardCardSource){
  return 'reportId' in card?card.reportId:[card.objectId,card.by??'all',card.sum].filter(Boolean).join('/');
}
export const portableDashboardDefinition=z.object({
  name:dashboardSchema.shape.name,
  cards:z.array(z.union([card,objectCard])).max(20).refine(cards=>new Set(cards.map(dashboardCardKey)).size===cards.length,'A report can appear once per dashboard.'),
}).strict();
export const portableDashboardSearch=z.preprocess(value=>typeof value==='string'?value.trim()||undefined:value,
  portableRecordSearch.refine(value=>!value.includes('\0')).optional());
const date=z.iso.date().refine(value=>value>='0001-01-01','Enter a valid calendar year.');
const dashboardFilterFields=z.object({createdFrom:date.optional(),createdThrough:date.optional(),dashboardPipeline:pipelineKey.optional()});
export type PortableDashboardFilters=z.output<typeof dashboardFilterFields>;
function datesValid(filters:PortableDashboardFilters){
  return (!filters.createdFrom&&!filters.createdThrough)||!!(filters.createdFrom&&filters.createdThrough&&filters.createdFrom<=filters.createdThrough);
}
export const portableDashboardFilters=dashboardFilterFields.strict().refine(datesValid,'Choose a start and end date in chronological order.');

export function filteredDashboardReport(definition:PortableReportDefinition,filters:PortableDashboardFilters){
  const result={...definition};
  if(definition.kind==='deals'&&filters.dashboardPipeline){
    if(definition.dealPipelineId&&definition.dealPipelineId!==filters.dashboardPipeline)return null;
    result.dealPipelineId=filters.dashboardPipeline;
  }
  if(filters.createdFrom&&filters.createdThrough){
    const saved=definition.createdDateRange;
    const from=saved&&saved.from>filters.createdFrom?saved.from:filters.createdFrom;
    const through=saved&&saved.through<filters.createdThrough?saved.through:filters.createdThrough;
    if(from>through)return null;
    result.createdDateRange={from,through};
  }
  return result;
}
export const portableDashboardRead=z.union([
  z.object({view:z.literal('dashboard'),id,workspaceId:id.optional(),...dashboardFilterFields.shape}).strict().refine(datesValid),
  z.object({view:z.literal('dashboardRecords'),id,reportId:id,workspaceId:id.optional(),after:id.optional(),
    ...dashboardFilterFields.shape,group:z.string().max(300).refine(value=>!value.includes('\0')).optional()}).strict().refine(datesValid),
  z.object({view:z.literal('dashboards'),workspaceId:id.optional(),after:id.optional(),search:portableDashboardSearch,limit:z.coerce.number().int().min(1).max(50).default(25)}).strict(),
]);
const save=z.object({action:z.literal('dashboard'),definition:portableDashboardDefinition,teamVisible:z.boolean().optional()});
export const portableDashboardWrite=z.union([
  save.strict(),save.extend({id,revision}).strict(),
  z.object({action:z.literal('deleteDashboard'),id,revision}).strict(),
]);

export type PortableDashboardDefinition=z.output<typeof portableDashboardDefinition>;
export type PortableDashboardRead=z.output<typeof portableDashboardRead>;
export type PortableDashboardWrite=z.output<typeof portableDashboardWrite>;
export type PortableDashboard={id:string;teamVisible:boolean;definition:PortableDashboardDefinition;revision:number;updatedAt:string};
export type PortableDashboardCard=(DashboardCardSource&{missing:true})|
  (z.output<typeof card>&{missing:false;definition:PortableReportDefinition;result:PortableReportResult})|
  (z.output<typeof objectCard>&{missing:false;custom:{name:string;fieldLabel?:string;sumLabel?:string;sum?:string|null;total:number;groups:{value:string|null;label:string;count:number;sum?:string|null}[]}});
export type PortableDashboardDetail={item:PortableDashboard;cards:PortableDashboardCard[]};

export type DashboardRecordsPage={kind:Kind;records:{id:string;name:string}[];next:string|null};
