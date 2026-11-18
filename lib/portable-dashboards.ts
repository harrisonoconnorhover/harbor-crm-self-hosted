import {z} from 'zod';
import {dashboardCardsSchema,dashboardSchema} from './reporting';
import {portableRecordSearch} from './portable-records';
import type {Kind} from './crm';
import type {PortableReportDefinition,PortableReportResult} from './portable-reports';

const id=z.string().guid("Invalid uuid").transform(value=>value.toLowerCase());
const revision=z.number().int().positive().max(2147483646);
const card=z.object({reportId:id,wide:z.boolean().default(false)}).strict();

export const portableDashboardDefinition=z.object({
  name:dashboardSchema.shape.name,
  cards:dashboardCardsSchema(card),
}).strict();
export const portableDashboardSearch=z.preprocess(value=>typeof value==='string'?value.trim()||undefined:value,
  portableRecordSearch.refine(value=>!value.includes('\0')).optional());
export const portableDashboardRead=z.union([
  z.object({view:z.literal('dashboard'),id,workspaceId:id.optional()}).strict(),
  z.object({view:z.literal('dashboardRecords'),id,reportId:id,workspaceId:id.optional(),after:id.optional(),
    group:z.string().max(300).refine(value=>!value.includes('\0')).optional()}).strict(),
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
export type PortableDashboardCard=PortableDashboardDefinition['cards'][number]&
  ({missing:true}|{missing:false;definition:PortableReportDefinition;result:PortableReportResult});
export type PortableDashboardDetail={item:PortableDashboard;cards:PortableDashboardCard[]};

export type DashboardRecordsPage={kind:Kind;records:{id:string;name:string}[];next:string|null};
