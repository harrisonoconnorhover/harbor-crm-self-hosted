import type {CapacityStatus} from './ticket-capacity-exclusions';

export type SlaPausePeriod={start:string;end:string|null};
export type SlaPauseState={conditions:CapacityStatus[];periods:SlaPausePeriod[]};
export type SlaClock={dueAt:string;warningAt:string|null;completedAt:string|null;pauseState?:SlaPauseState|null};

// Cap every interval at the actual outcome, including a reply discovered later.
// The original deadlines remain stored; projected deadlines include only time
// that the clock did not run. No periodic writer is required.
export function slaClockProjection(clock:SlaClock,asOf:string){
 const cutoff=Date.parse(clock.completedAt||asOf),periods=clock.pauseState?.periods??[];
 const pausedMilliseconds=periods.reduce((total,p)=>total+Math.max(0,Math.min(cutoff,p.end?Date.parse(p.end):cutoff)-Date.parse(p.start)),0);
 const last=periods.at(-1),pausedAt=!clock.completedAt&&last&&!last.end&&Date.parse(last.start)<=Date.parse(asOf)?last.start:null;
 const shifted=(at:string)=>new Date(Date.parse(at)+pausedMilliseconds).toISOString();
 return {dueAt:shifted(clock.dueAt),warningAt:clock.warningAt?shifted(clock.warningAt):null,pausedAt,pausedMilliseconds};
}

export function plannedSlaPause(state:SlaPauseState|null|undefined,data:{ticketPipelineId?:unknown;ticketStatus?:unknown},completedAt:string|null,asOf:string):SlaPauseState|null{
 if(!state)return null;
 const periods=state.periods.filter(p=>p.start<=asOf).map(p=>({...p,end:p.end&&p.end<=asOf?p.end:null}));
 const last=periods.at(-1),active=last&&!last.end;
 const paused=!completedAt&&state.conditions.some(c=>c.pipelineId===(data.ticketPipelineId||'default')&&c.statusId===data.ticketStatus);
 if(active&&!paused)last.end=asOf;
 if(!active&&paused)periods.push({start:asOf,end:null});
 return {conditions:state.conditions,periods};
}
