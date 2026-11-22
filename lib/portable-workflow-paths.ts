import type {ContactFields} from './portable-records';
import {validWorkflowAmount,validWorkflowDate} from './portable-workflows';
import type {PortableConditionalPaths,PortableWorkflowDefinition} from './portable-workflows';

type Condition=PortableConditionalPaths['paths'][number]['conditions'][number];

export type PathContact=Partial<Record<Exclude<Condition['field'],'ticketTags'>,string>>&{ticketTags?:string[]};

function matches(contact:PathContact,condition:Condition){
  const expected=condition.value.trim().toLowerCase();
  if(condition.field==='ticketTags'){
    const tags=contact.ticketTags??[];
    switch(condition.operator){
      case 'known':return tags.length>0;
      case 'unknown':return tags.length===0;
      case 'has_tag':return tags.some(tag=>tag.trim().toLowerCase()===expected);
      case 'lacks_tag':return !tags.some(tag=>tag.trim().toLowerCase()===expected);
      default:return false;
    }
  }
  const actual=contact[condition.field]?.trim().toLowerCase()??'';
  if(condition.field==='dealAmount'&&condition.operator!=='known'&&condition.operator!=='unknown'){
    if(!validWorkflowAmount(actual)||!validWorkflowAmount(expected))return false;
    const amount=Number(actual),threshold=Number(expected);
    switch(condition.operator){
      case 'eq':return amount===threshold;
      case 'neq':return amount!==threshold;
      case 'gte':return amount>=threshold;
      case 'lte':return amount<=threshold;
      default:return false;
    }
  }
  if(condition.field==='dealCloseDate'&&(condition.operator==='gte'||condition.operator==='lte')){
    // Valid ISO calendar dates sort chronologically without a time zone conversion.
    if(!validWorkflowDate(actual)||!validWorkflowDate(expected))return false;
    return condition.operator==='gte'?actual>=expected:actual<=expected;
  }
  switch(condition.operator){
    case 'known':return actual.length>0;
    case 'unknown':return actual.length===0;
    case 'eq':return actual===expected;
    case 'neq':return actual.length>0&&actual!==expected;
    case 'contains':return actual.includes(expected);
    case 'not_contains':return actual.length>0&&!actual.includes(expected);
  }
}

// Older workers use availableAt alone during a rolling upgrade.
const waitingAvailability=Date.UTC(9999,0,1);
export function workflowSchedule(at:number,delayMinutes:number,waitForLifecycle?:ContactFields['lifecycle']){
  const scheduledFor=at+delayMinutes*60_000;
  return {scheduledFor,availableAt:waitForLifecycle?waitingAvailability:scheduledFor,waitForLifecycle};
}

export function conditionGroups<T extends {conditions:Condition[];mode:'all'|'any'}>(path:T&{orGroups?:T[]}):T[]{
  return [path,...(path.orGroups??[])];
}

export function selectConditionalPath(plan:Pick<PortableConditionalPaths,'paths'|'otherwise'>,contact:PathContact){
  return plan.paths.find(path=>conditionGroups(path).some(({mode,conditions})=>mode==='all'?
    conditions.every(rule=>matches(contact,rule)):conditions.some(rule=>matches(contact,rule))))??plan.otherwise;
}

/** Resolve the saved definition once inside the enrollment transaction. */
export function workflowJobAction(definition:PortableWorkflowDefinition,lifecycle:string|undefined|null,contact?:PathContact){
  if(definition.actionKind==='note_branch')return {action:definition.lifecycle===lifecycle?definition.match:definition.otherwise};
  if(definition.actionKind==='code')return {action:{body:'JavaScript action',delayMinutes:definition.delayMinutes}};
  if(definition.actionKind==='note_sequence')return {action:definition.steps[0]};
  if(definition.actionKind!=='conditional_paths')return {action:definition};
  if(!contact)throw Error('Contact data is required to select a workflow path.');
  const path=selectConditionalPath(definition,contact);
  return {action:path.action,path};
}

export function workflowPathActions(path:PortableConditionalPaths['otherwise']){
  return [{id:path.id,action:path.action},...(path.then??[])];
}

export function workflowWebhookNames(definition?:PortableWorkflowDefinition){
  if(definition?.actionKind!=='conditional_paths')return [];
  return [...definition.paths,definition.otherwise].flatMap(workflowPathActions).flatMap(({action})=>action.kind==='webhook'?[action.destination]:[]);
}

export function workflowJobBody(action:{body:string}|{task:{name:string}}|{kind:'webhook';destination:string}){
  if('task' in action)return action.task.name;
  if('body' in action)return action.body;
  return 'Send webhook to '+action.destination;
}

// Manual run IDs are client-supplied and unique within a workspace.
export const workflowWebhookEventId=(workspaceId:string,jobId:string)=>workspaceId+'/'+jobId;
