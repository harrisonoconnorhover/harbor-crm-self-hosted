import {datedActivityTypes} from './activity-date-policy';
import {z} from 'zod';
import {kinds,type Kind} from './crm';
export const fileUsageFilters=z.object({status:z.enum(['all','live','deleted','pending']).default('all'),kind:z.enum(['all',...kinds]).default('all'),type:z.enum(['all',...datedActivityTypes]).default('all'),query:z.string().max(200).default('')}).strict();
export type FileUsageFilters=z.infer<typeof fileUsageFilters>;
export type FileUsageRow={state:'live'|'deleted'|'pending';activityId:string;recordId:string;kind:Kind;name:string;type:string;body:string;occurredAt:string;deletedAt:string;expiresAt:string};
export type FileUsagePage={results:FileUsageRow[];total:number;activityCount:number;recordCount:number;next:string|null;accessibleKinds:Kind[]};
