import type {CRMRecord,Kind} from './crm';
import type {FilterField} from './filters';
export const currentStageFieldIds=['currentStageEnteredAt','daysInCurrentStage'] as const;
export const isCurrentStageField=(id:string)=>currentStageFieldIds.some(f=>f===id);
export const hasStageHistory=(kind:string)=>['deals','contacts','companies'].includes(kind);
export function currentStageFields(kind:Kind):FilterField[] {
  if(!hasStageHistory(kind))return [];
  const label=kind==='deals'?'stage':'lifecycle stage';
  const description='Read-only observed entry. Unknown when history is missing or unreliable. Restoring a record starts a new observed interval; deleted time is excluded. Days are elapsed 24-hour periods, including fractions.';
  return [{id:'currentStageEnteredAt',label:`Entered current ${label}`,type:'date',description},{id:'daysInCurrentStage',label:`Days in current ${label}`,type:'number',description}];
}
// Definitions use field IDs in rules, columns, sorting, measures and bindings.
export function usesCurrentStageFields(value:unknown):boolean {
  return typeof value==='string'?(isCurrentStageField(value.replace(/^associated:/,''))||[...value.matchAll(/\[([^\]]+)\]/g)].some(m=>isCurrentStageField(m[1].replace(/^associated:/,'')))):Array.isArray(value)?value.some(usesCurrentStageFields):!!value&&typeof value==='object'?Object.entries(value).some(([key,v])=>key!=='quickFilters'&&usesCurrentStageFields(v)):false;
}
export function stageIdentity(r:Pick<CRMRecord,'kind'|'data'>):string {
  return r.kind==='deals'?JSON.stringify([r.data.pipelineId||'default',r.data.stage||'']):JSON.stringify(['default',r.data.lifecycle??'Lead']);
}
// Workflow changes are not history until committed. Preserve an unchanged state,
// and use the commit timestamp for a new state, never the previous stage age.
export function plannedStageValues(original:CRMRecord,current:CRMRecord,now:Date) {
  return stageIdentity(original)===stageIdentity(current)?{currentStageEnteredAt:original.currentStageEnteredAt,daysInCurrentStage:original.daysInCurrentStage}:
    original.stageHistoryReliable===false?{currentStageEnteredAt:null,daysInCurrentStage:null}:{currentStageEnteredAt:now.toISOString(),daysInCurrentStage:0};
}

// Associated conditions carry their own object kind. Keep them out of the
// primary scan so a related-company rule does not hydrate every contact too.
export function currentStageKinds(kind:Kind,value:unknown):Kind[] {
  const needed=new Set<Kind>();
  function visit(node:unknown,primary:Kind) {
    if(Array.isArray(node)){node.forEach(v=>visit(v,primary));return;}
    if(node&&typeof node==='object'){
      const v=node as Record<string,unknown>;
      for(const [key,child] of Object.entries(v)){
        if(key==='quickFilters')continue;
        if(key==='associatedCriteria'&&Array.isArray(child)){
          for(const rule of child)visit(rule.groups,rule.kind);
        }else visit(child,primary);
      }
      const associated=v.association as {kind?:Kind}|undefined;
      if(associated?.kind&&usesCurrentStageFields(node)&&hasStageHistory(associated.kind))needed.add(associated.kind);
    }else if(usesCurrentStageFields(node)&&hasStageHistory(primary))needed.add(primary);
  }
  visit(value,kind);return [...needed];
}
