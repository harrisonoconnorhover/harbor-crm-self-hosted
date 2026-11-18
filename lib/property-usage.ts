import { z } from 'zod';
import {utcDateTime} from './iso-date-time';
import { kinds, type Kind } from './crm';
import { viewConfigSchema } from './workspace';
import { reportSchema } from './reporting';
import { workflowSchema } from './workflows/model';
import { segmentCriteriaSchema } from './segments';
import { parseReportFormula } from './report-formulas';
import type { PropertyFill } from './property-definition-export';

export const usageSources = ['views','reports','workflows','segments','pipelines','layouts','tags','colors','organization','runs','batches','segmentQueue','commerceQueue','dashboards','recordQueue','logic'] as const;
export type UsageSource = typeof usageSources[number];
export const usageSourceLabels: Record<UsageSource,string> = {logic:'Conditional property logic',views:'Saved view',reports:'Report',workflows:'Workflow',segments:'Segment',pipelines:'Pipeline settings',layouts:'Record layout',tags:'Deal tags',colors:'Property colors',organization:'Property group',runs:'Active workflow run',batches:'Enrollment batch',segmentQueue:'Queued segment enrollment',commerceQueue:'Queued commerce enrollment',recordQueue:'Queued record enrollment',dashboards:'Dashboard card'};
export type UsageAsset = {id:string;name:string;kind:string;body:unknown;linkId?:string};
export type PropertyUsage = {source:UsageSource;id:string;name:string;kind:string;references:string[];review:string[];href?:string;linkLabel?:string};
export type UsagePage = {items:PropertyUsage[];next:string|null;scanned:number;complete:boolean;fill?:PropertyFill;label:string;startedAt:string};
export const usageQuery = z.object({kind:z.enum(kinds),field:z.string().min(1).max(150),cursor:z.string().max(2000).optional()});
const cursorShape=z.object({kind:z.enum(kinds),field:z.string().min(1).max(150),source:z.number().int().min(0).max(usageSources.length),after:z.string().max(300),startedAt:utcDateTime});
export type UsageCursor=z.infer<typeof cursorShape>;
export function decodeUsageCursor(cursor:string,kind:Kind,field:string){let value;try{value=cursorShape.parse(JSON.parse(atob(cursor)));}catch{throw Error('Invalid usage cursor. Restart the scan.');}if(value.kind!==kind||value.field!==field)throw Error('This cursor belongs to another property. Restart the scan.');return value;}
export const encodeUsageCursor=(cursor:UsageCursor)=>btoa(JSON.stringify(cursor));
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const arr=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const str=(v:unknown)=>typeof v==='string'?v:'';

export function inspectPropertyUsage(source:UsageSource,asset:UsageAsset,targetKind:Kind,field:string):PropertyUsage|null{
 const refs=new Set<string>(),review=new Set<string>();
 const schema=source==='views'?viewConfigSchema:source==='reports'?reportSchema:source==='segments'?segmentCriteriaSchema:['workflows','runs','batches','segmentQueue','commerceQueue','recordQueue'].includes(source)?workflowSchema:null;
 const parsed=schema?.safeParse(asset.body);
 const body=obj(parsed?.success?parsed.data:asset.body);
 if(parsed && !parsed.success && (!asset.kind || asset.kind===targetKind || obj(body.association).kind===targetKind))review.add('Configuration could not be fully validated; inspect manually.');
 const hit=(kind:unknown,id:unknown,label:string)=>{if(kind===targetKind&&id===field)refs.add(label);};
 const list=(kind:unknown,ids:unknown,label:string)=>arr(ids).forEach(id=>hit(kind,id,label));
 const groups=(kind:unknown,value:unknown,label:string)=>arr(value).forEach(g=>arr(g).forEach(rule=>{hit(kind,obj(rule).field,label);if(obj(rule).compareField)hit(kind,obj(rule).compareField,label+' · comparison property');}));
 function conditions(kind:unknown,value:unknown,label:string){const v=obj(value);if(kind===targetKind&&(arr(v.segmentConditions).length||arr(v.segmentGroups).length||v.segmentTrigger))review.add('Membership dependency: inspect the referenced segments for indirect property usage.');groups(kind,v.groups,label);groups(kind,v.reEnrollmentGroups,'Re-enrollment conditions');for(const raw of arr(v.associatedCriteria)){const c=obj(raw);groups(c.kind,c.groups,label+' on associated '+str(c.kind));}}
 function bindings(kind:unknown,value:unknown,label:string){if(Array.isArray(value)){value.forEach(v=>bindings(kind,v,label));return;}const v=obj(value);if(v.source==='property')hit(kind,v.value,label);for(const [key,child]of Object.entries(v))if(!['code','sampleResponse','groups','associatedCriteria'].includes(key)&&child&&typeof child==='object')bindings(kind,child,label);}
 function workflow(kind:unknown,value:unknown){const d=obj(value);conditions(kind,d,'Enrollment conditions');
  function steps(value:unknown){for(const raw of arr(value)){const s=obj(raw),name=str(s.name)||str(s.type);conditions(kind,s,'Conditions · '+name);bindings(kind,s,'Property input · '+name);
   if(s.type==='set')hit(kind,s.field,'Set property · '+name);
   if(s.type==='code'){for(const input of arr(s.inputs))hit(kind,obj(input).field,'Code input · '+name);if(kind===targetKind)review.add('Custom code · '+name+' (may read or write properties dynamically)');}
   if(s.type==='branch'){for(const path of arr(s.paths)){conditions(kind,path,'Branch · '+str(obj(path).name));steps(obj(path).steps);}steps(s.otherwise);}
  }}steps(d.steps);
 }
 // Commerce reports expose some current CRM properties through named projections.
 const commerceAliases:Record<string,[Kind,string]>={currentDealName:['deals','name'],currentDealOwner:['deals','owner'],currentPipelineId:['deals','pipelineId'],currentPipelineName:['deals','pipelineId'],currentStageId:['deals','stage'],currentStageName:['deals','stage'],currentDealOutcome:['deals','stage'],currentDealCloseDate:['deals','closeDate'],currentCompanyName:['companies','name'],currentCompanyIndustry:['companies','industry'],currentContactName:['contacts','name'],currentContactLifecycle:['contacts','lifecycle']};
 function report(value:unknown,prefix=''){const d=obj(value),kind=d.kind,related=obj(d.association).kind;if(arr(d.segmentConditions).length&&(kind===targetKind||related===targetKind||(kind==='activities'&&(d.activityRecordKind||d.segmentKind||'contacts')===targetKind)))review.add('Membership dependency: inspect the referenced segments for indirect property usage.');
  const reportHit=(id:unknown,label:string)=>{if(typeof id!=='string')return;if(kind==='activities'&&id.startsWith('record:'))hit(d.activityRecordKind,id.slice(7),prefix+label+' on associated records');else if(id.startsWith('associated:'))hit(related,id.slice(11),prefix+label);else if(['quotes','invoices','payments','quote_lines','invoice_lines'].includes(str(kind))&&commerceAliases[id]){const [k,f]=commerceAliases[id];hit(k,f,prefix+label+' via linked CRM record');}else if(kind==='line_items'){const aliases:Record<string,string>={dealName:'name',dealOwner:'owner',pipelineName:'pipelineId',pipelineId:'pipelineId',stageName:'stage',stageId:'stage',dealOutcome:'stage',closeDate:'closeDate',createdAt:'createdAt',updatedAt:'updatedAt'};if(aliases[id])hit('deals',aliases[id],prefix+label+' via linked deal');}else if(kind==='activities'&&['recordName','recordOwner'].includes(id)){hit(d.activityRecordKind||targetKind,id==='recordName'?'name':'owner',prefix+label+(d.activityRecordKind?' on associated records':' on linked records (any object)'));}else hit(kind,id,prefix+label);};
  reportHit(d.groupBy,'Grouping');reportHit(obj(d.breakdown).field,'Breakdown');if(d.metric!=='count')reportHit(d.measure,'Metric');for(const metric of arr(d.additionalMetrics))if(obj(metric).metric!=='count')reportHit(obj(metric).measure,'Additional metric');
  for(const g of arr(d.groups))for(const rule of arr(g)){reportHit(obj(rule).field,'Report filter');reportHit(obj(rule).compareField,'Report comparison property');}
  for(const formula of arr(d.formulas)){try{for(const f of parseReportFormula(str(obj(formula).expression)).fields)reportHit(f,'Formula · '+str(obj(formula).label));}catch{if(kind===targetKind||related===targetKind)review.add('Formula could not be inspected · '+str(obj(formula).label));}}
  if(d.chart==='funnel'||d.chart==='stageTime'){hit(kind,kind==='deals'?'stage':'lifecycle',prefix+'Stage-history analysis');if(kind==='deals')hit(kind,'pipelineId',prefix+'Stage-history pipeline');if(obj(d.funnel).ownerMode&&obj(d.funnel).ownerMode!=='all')hit(kind,'owner',prefix+'Stage-history owner filter');}
  return reportHit;
 }
 function view(kind:unknown,value:unknown,label=''){const d=obj(value);conditions(kind,d,label+'View filters');list(kind,d.columns,label+'Table columns');list(kind,d.quickFilters,label+'Quick filters');hit(kind,obj(d.columnSort).field,label+'Column sorting');
  if(d.propertyId)hit(kind,'custom:'+str(d.propertyId),label+'Quick custom-property filter');
  if(d.mine)hit(kind,'owner',label+'My records');if(d.filter)hit(kind,kind==='deals'?'stage':kind==='tasks'?'status':kind==='tickets'?'ticketStatus':'lifecycle',label+'Status filter');
  if(d.tagId&&targetKind==='deals')review.add('Tag dependency: inspect deal tag rules for indirect property usage.');
  if(kind==='deals'&&d.pipelineId)hit(kind,'pipelineId',label+'Pipeline selection');if(kind==='tasks'&&d.taskScope!=='all'){hit(kind,'dueDate',label+'Task date scope');hit(kind,'status',label+'Task date scope');}
  if(!d.columnSort&&d.sort==='name')hit(kind,'name',label+'Name sorting (default)');
  if(d.sort==='lastContacted')hit(kind,'lastContacted',label+'Sorting');if(d.sort==='created')hit(kind,'createdAt',label+'Sorting');
  if(kind==='deals'){list(kind,obj(d.boardCards).fields,label+'Board card properties');hit(kind,obj(d.boardGrouping).field,label+'Board grouping');for(const metric of arr(obj(d.boardSummary).metrics)){const f=obj(metric).field;hit(kind,f==='weighted'||f==='weightedAmount'?'amount':f,label+'Board metric');if(f==='weighted'||f==='weightedAmount')hit(kind,'stage',label+'Weighted board metric');}}
  for(const [related,raw] of Object.entries(obj(obj(d.associations).tables))){const table=obj(raw);list(related,table.columns,'Associated '+related+' columns');hit(related,obj(table.sort).field,'Associated '+related+' sorting');groups(related,table.groups,'Associated '+related+' filters');}
 }
 if(source==='views')view(asset.kind,body);
 else if(source==='reports')report(body);
 else if(['workflows','runs','batches','segmentQueue','commerceQueue','recordQueue'].includes(source)){if(!asset.body){if(asset.kind===targetKind||!asset.kind)review.add('Saved workflow revision unavailable; inspect this execution manually.');}else workflow(body.kind||asset.kind,body);}
 else if(source==='segments')conditions(asset.kind,body,'Segment criteria');
 else if(source==='layouts')list(asset.kind,body.fields,'Explicit '+str(body.surface)+' sidebar layout');
 else if(source==='colors')hit(asset.kind,body.field,'Option colors');
 else if(source==='organization'){const assigned=obj(body.assignments)[field];if(asset.kind===targetKind&&assigned){const group=arr(body.groups).map(obj).find(g=>g.id===assigned);refs.add('Assigned property group · '+(str(group?.name)||str(assigned)));}}
 else if(source==='tags')for(const tag of arr(body.tags))groups('deals',obj(tag).groups,'Tag condition · '+str(obj(tag).name));
 else if(source==='pipelines'){
  for(const pipeline of arr(body.leadPipelines)){const p=obj(pipeline);if(arr(p.createOnLifecycle).length)hit('contacts','lifecycle','Lead lifecycle creation · '+str(p.name));if(p.followUp){hit('leads','disqualificationCategory','Disqualification follow-up trigger · '+str(p.name));hit('leads','leadType','Follow-up Lead type · '+str(p.name));}}
  for(const pipeline of arr(body.pipelines)){const p=obj(pipeline);for(const [stage,properties]of Object.entries(obj(p.stageProperties)))for(const property of arr(properties))hit('deals',obj(property).field,`${obj(property).required?'Required':'Optional'} stage property · ${str(p.name)} / ${str(obj(p.stageLabels)[stage])||stage}`);}
  for(const pipeline of arr(body.pipelines)){const p=obj(pipeline);for(const rule of arr(p.stagePropertyRules))for(const property of arr(obj(rule).properties))hit('deals',obj(property).field,`${obj(property).required?'Required':'Optional'} multi-stage property · ${str(p.name)} · ${str(obj(rule).operator)}`);}
  for(const pipeline of arr(obj(body.tickets).pipelines)){const p=obj(pipeline);for(const stage of arr(p.stages))for(const property of arr(obj(stage).properties))hit('tickets',obj(property).field,`${obj(property).required?'Required':'Optional'} status property · ${str(p.name)} / ${str(obj(stage).label)}`);}
  for(const pipeline of arr(obj(body.tickets).pipelines)){const p=obj(pipeline);for(const rule of arr(p.stagePropertyRules))for(const property of arr(obj(rule).properties))hit('tickets',obj(property).field,`${obj(property).required?'Required':'Optional'} multi-status property · ${str(p.name)} · ${str(obj(rule).operator)}`);}
  for(const [kind,pipelines] of [['deals',body.pipelines],['tickets',obj(body.tickets).pipelines]])for(const pipeline of arr(pipelines)){const p=obj(pipeline);for(const rule of arr(p.stagePropertyRules))for(const condition of arr(obj(rule).conditions))hit(kind,obj(condition).field,'Stage rule condition · '+str(p.name));}
 }else if(source==='logic'){
  for(const rule of arr(body.rules)){for(const c of arr(obj(rule).conditions))hit(asset.kind,obj(c).field,'Controlling property');for(const p of arr(obj(rule).properties))hit(asset.kind,obj(p).field,'Dependent property');}
 }else if(source==='dashboards'){
  const reportHit=report(body.report,'Dashboard report · '),card=obj(body.card),filters=obj(body.filters),kind=obj(body.report).kind;
  if(filters.period&&filters.period!=='all'&&card.dateField&&!['none','auto'].includes(str(card.dateField)))reportHit(card.dateField,'Dashboard date filter');
  if(filters.ownerMode&&filters.ownerMode!=='all'&&card.filterOwner!==false)reportHit(kind==='activities'?'recordOwner':kind==='line_items'?'dealOwner':'owner','Dashboard owner filter');
 }
 if(!refs.size&&!review.size)return null;
 const destination=source==='reports'?{href:'#reports/'+encodeURIComponent(asset.id),linkLabel:'Open report'}:source==='dashboards'?{href:'#dashboards/'+encodeURIComponent(asset.linkId||asset.id),linkLabel:'Open dashboard'}:source==='views'?{href:'#'+asset.kind+'?view='+encodeURIComponent(asset.id),linkLabel:'Open saved view'}:source==='segments'?{href:'#segments',linkLabel:'Open segment library'}:['workflows','runs','batches','segmentQueue','commerceQueue','recordQueue'].includes(source)?{href:'#workflows',linkLabel:'Open workflow library'}:{};
 return {source,id:asset.id,name:asset.name,kind:asset.kind,references:[...refs],review:[...review],...destination};
}
