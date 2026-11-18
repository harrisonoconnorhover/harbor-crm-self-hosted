import {z} from 'zod';
import {capacityStatus,type CapacityStatus} from './ticket-capacity-exclusions';
import {slaClockProjection,type SlaPauseState} from './ticket-sla-pause';
export const slaPriorities=['Urgent','High','Medium','Low'] as const;
const target=z.number().int().min(1).max(525600).nullable();
export const closeSlaTargets=z.object({Urgent:target,High:target,Medium:target,Low:target}).strict();
export type CloseSlaTargets=z.infer<typeof closeSlaTargets>;
export const closeSlaInput=z.object({revision:z.number().int().nonnegative(),enabled:z.boolean(),targets:closeSlaTargets,warningMinutes:z.number().int().min(0).max(525600),pipelineRevision:z.number().int().nonnegative().optional(),pauseConditions:z.array(capacityStatus).max(1000).refine(v=>new Set(v.map(c=>JSON.stringify([c.pipelineId,c.statusId]))).size===v.length,'Choose each pause condition once.').optional()}).strict().superRefine((v,c)=>{
 if(v.enabled&&Object.values(v.targets).every(n=>n===null))c.addIssue({code:'custom',message:'Set at least one priority target before enabling SLAs.'});
 if(Object.values(v.targets).some(n=>n!==null&&v.warningMinutes>n))c.addIssue({code:'custom',message:'The due-soon warning cannot be longer than a configured target.'});
});
export const defaultCloseSla={enabled:false,targets:{Urgent:60,High:240,Medium:480,Low:1440} as CloseSlaTargets,warningMinutes:15,pauseConditions:[] as CapacityStatus[]};
export type CloseSlaPolicy=typeof defaultCloseSla&{workspaceId:string;revision:number;updatedAt:string|null;pipelineRevision:number;pipelines:{id:string;name:string;statuses:{id:string;label:string;outcome:'open'|'closed'}[]}[]};
export type CloseSlaReceipt={recordId:string;policyRevision:number;priority:string;targetMinutes:number;warningMinutes:number;startedAt:string;dueAt:string;warningAt:string|null;completedAt:string|null;appliedAt:string;pauseState?:SlaPauseState|null;pausedAt?:string|null;pausedMilliseconds?:number};
export type CloseSlaStatus='active'|'due_soon'|'overdue'|'met'|'late'|'paused';
export const closeSlaLabels:Record<CloseSlaStatus,string>={active:'Active SLA',due_soon:'Due soon',overdue:'Overdue',met:'SLA completed on time',late:'SLA completed late',paused:'Paused'};
export function closeSlaStatus(receipt:Pick<CloseSlaReceipt,'dueAt'|'warningAt'|'completedAt'|'pauseState'>,asOf:string):CloseSlaStatus{
 const clock=slaClockProjection(receipt,asOf),due=Date.parse(clock.dueAt);if(receipt.completedAt)return Date.parse(receipt.completedAt)<=due?'met':'late';
 if(clock.pausedAt)return 'paused';
 if(Date.parse(asOf)>due)return 'overdue';
 return clock.warningAt&&Date.parse(asOf)>=Date.parse(clock.warningAt)?'due_soon':'active';
}
export type CloseSlaRecord={asOf:string;receipt:CloseSlaReceipt|null;status:CloseSlaStatus|null;firstAgentEmailResponseAt?:string|null;timeToFirstAgentEmailReplyHours?:number|null};
export const defaultFirstResponseSla={enabled:false,targets:{Urgent:15,High:60,Medium:240,Low:480} as CloseSlaTargets,warningMinutes:5,pauseConditions:[] as CapacityStatus[]};
export type TicketSlaGoal='close'|'firstResponse';
