import type {FilterField} from './filters';
import type {CRMRecord,Kind} from './crm';
import type {DealStageSource} from './forecast';
import {ticketStageFor} from './ticket-pipelines';
import {closeSlaStatus,closeSlaLabels,type CloseSlaReceipt,type CloseSlaStatus} from './ticket-sla';
import {slaClockProjection,plannedSlaPause} from './ticket-sla-pause';

export const firstResponseFieldIds=['firstResponseSlaStatus','firstResponseSlaDueAt','firstResponseSlaWarningAt','firstResponseSlaStartedAt','firstResponseSlaCompletedAt','firstResponseSlaTargetMinutes','firstAgentEmailResponseAt','timeToFirstAgentEmailReplyHours'] as const;
export const ticketSlaFieldIds=['closeSlaStatus','closeSlaDueAt','closeSlaWarningAt','closeSlaStartedAt','closeSlaCompletedAt','closeSlaTargetMinutes',...firstResponseFieldIds] as const;
export type TicketSlaField=typeof ticketSlaFieldIds[number];
export const isTicketSlaField=(id:string):id is TicketSlaField=>ticketSlaFieldIds.some(f=>f===id);
export type FirstResponseProperties={firstResponseSlaStatus:CloseSlaStatus|null;firstResponseSlaDueAt:string|null;firstResponseSlaWarningAt:string|null;firstResponseSlaStartedAt:string|null;firstResponseSlaCompletedAt:string|null;firstResponseSlaTargetMinutes:number|null;firstAgentEmailResponseAt:string|null;timeToFirstAgentEmailReplyHours:number|null};
export const isTicketSlaStatusField=(id:string)=>id==='closeSlaStatus'||id==='firstResponseSlaStatus';
export const isTicketSlaNumberField=(id:string)=>id==='closeSlaTargetMinutes'||id==='firstResponseSlaTargetMinutes'||id==='timeToFirstAgentEmailReplyHours';
export const isTicketSlaDateField=(id:string)=>isTicketSlaField(id)&&!isTicketSlaStatusField(id)&&!isTicketSlaNumberField(id);
export type TicketSlaProperties=Partial<FirstResponseProperties>&{closeSlaStatus:CloseSlaStatus|null;closeSlaDueAt:string|null;closeSlaWarningAt:string|null;closeSlaStartedAt:string|null;closeSlaCompletedAt:string|null;closeSlaTargetMinutes:number|null};
const description='Read-only close SLA snapshot. Unknown for tickets without an applied goal. Status is calculated at the read time; time passing alone does not create a record edit.';
export function ticketSlaFields(kind:Kind):FilterField[]{return kind!=='tickets'?[]:[
 {id:'closeSlaStatus',label:'Time to close SLA status',type:'select',options:Object.keys(closeSlaLabels),optionLabels:closeSlaLabels,group:'Ticket information',description},
 {id:'closeSlaDueAt',label:'Time to close SLA due date',type:'datetime',group:'Ticket information',description},
 {id:'closeSlaWarningAt',label:'Time to close SLA due-soon date',type:'datetime',group:'Ticket information',description},
 {id:'closeSlaStartedAt',label:'Time to close SLA start date',type:'datetime',group:'Ticket information',description},
 {id:'closeSlaCompletedAt',label:'Time to close SLA completion date',type:'datetime',group:'Ticket information',description},
 {id:'closeSlaTargetMinutes',label:'Time to close SLA target (minutes)',type:'number',group:'Ticket information',description},
 ...firstResponseFields(),
 ];}
function firstResponseFields():FilterField[]{const description='Read-only first-response measurement. Counts confirmed Harbor-sent replies associated with this ticket when logged, not initial outreach, forwards, manual logs or replies sent directly from Gmail. Tracking starts when a ticket is created after this feature was added; pre-feature reply history stays unknown. SLA goals apply only at new-ticket creation.';return firstResponseFieldIds.map(id=>({id,label:({firstResponseSlaStatus:'Time to first response SLA status',firstResponseSlaDueAt:'Time to first response SLA due date',firstResponseSlaWarningAt:'Time to first response SLA due-soon date',firstResponseSlaStartedAt:'Time to first response SLA start date',firstResponseSlaCompletedAt:'Time to first response SLA completion date',firstResponseSlaTargetMinutes:'Time to first response SLA target (minutes)',firstAgentEmailResponseAt:'First agent email response date',timeToFirstAgentEmailReplyHours:'Time to first agent email reply (hours)'})[id],type:isTicketSlaStatusField(id)?'select':isTicketSlaNumberField(id)?'number':'datetime',...(isTicketSlaStatusField(id)?{options:Object.keys(closeSlaLabels),optionLabels:closeSlaLabels}:{}),group:'Ticket information',description}));}
export function usesTicketSlaFields(value:unknown):boolean{
 if(typeof value==='string')return isTicketSlaField(value.replace(/^(associated:|record:|record\.)/,''))||[...value.matchAll(/\[([^\]]+)\]/g)].some(m=>isTicketSlaField(m[1].replace(/^associated:/,'')));
 return Array.isArray(value)?value.some(usesTicketSlaFields):!!value&&typeof value==='object'?Object.entries(value).some(([key,v])=>key!=='quickFilters'&&usesTicketSlaFields(v)):false;
}
export function closeSlaProperties(receipt:CloseSlaReceipt|null,asOf:string):TicketSlaProperties{
 const clock=receipt?slaClockProjection(receipt,asOf):null;
 return {closeSlaStatus:receipt?closeSlaStatus(receipt,asOf):null,closeSlaDueAt:clock?.dueAt??null,closeSlaWarningAt:clock?.warningAt??null,closeSlaStartedAt:receipt?.startedAt??null,closeSlaCompletedAt:receipt?.completedAt??null,closeSlaTargetMinutes:receipt?.targetMinutes??null};
}
// Workflow simulation and prior-state comparisons use the same snapshotted goal,
// but the candidate's current Open/Closed state, never its stale receipt status.
export function plannedCloseSlaProperties(original:CRMRecord,current:CRMRecord,now:Date,catalog:DealStageSource){
 const p=original.closeSlaProperties;if(current.kind!=='tickets'||!p)return {};
 if(original.ticketSlaClocks){
  const at=now.toISOString(),next={...original.ticketSlaClocks},values={...p};
  if(next.close){
   const completedAt=ticketStageFor(catalog,current.data)?.outcome==='closed'?(current.data.closedAt||p.closeSlaCompletedAt||at):null;
   next.close={...next.close,completedAt,pauseState:plannedSlaPause(next.close.pauseState,current.data,completedAt,at)};
   const clock=slaClockProjection(next.close,at);
   Object.assign(values,{closeSlaStatus:closeSlaStatus(next.close,at),closeSlaDueAt:clock.dueAt,closeSlaWarningAt:clock.warningAt,closeSlaCompletedAt:completedAt});
  }
  if(next.firstResponse){
   next.firstResponse={...next.firstResponse,pauseState:plannedSlaPause(next.firstResponse.pauseState,current.data,next.firstResponse.completedAt,at)};
   const clock=slaClockProjection(next.firstResponse,at);
   Object.assign(values,{firstResponseSlaStatus:closeSlaStatus(next.firstResponse,at),firstResponseSlaDueAt:clock.dueAt,firstResponseSlaWarningAt:clock.warningAt});
  }
  return {closeSlaProperties:values,ticketSlaClocks:next};
 }
 if(!p.closeSlaDueAt)return {closeSlaProperties:p};
 const completedAt=ticketStageFor(catalog,current.data)?.outcome==='closed'?(current.data.closedAt||p.closeSlaCompletedAt||now.toISOString()):null;
 return {closeSlaProperties:{...p,closeSlaCompletedAt:completedAt,closeSlaStatus:closeSlaStatus({dueAt:p.closeSlaDueAt,warningAt:p.closeSlaWarningAt,completedAt},now.toISOString())}};
}
