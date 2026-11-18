import type {FilterField} from './filters';
export const hasCommerceCRMContext=(kind:string)=>['quotes','invoices','payments','quote_lines','invoice_lines'].includes(kind);
const text=(id:string,label:string):FilterField=>({id,label,type:'text'});
export const commerceCRMFields:FilterField[]=[
 {id:'crmLinkState',label:'Source deal link',type:'select',options:['Available','Unavailable','No source deal']},
 text('currentDealId','Linked deal ID (current)'),text('currentDealName','Linked deal name (current)'),text('currentDealOwner','Linked deal owner (current)'),
 text('currentPipelineId','Linked deal pipeline ID (current)'),text('currentPipelineName','Linked deal pipeline (current)'),text('currentStageId','Linked deal stage ID (current)'),text('currentStageName','Linked deal stage (current)'),
 {id:'currentDealOutcome',label:'Linked deal outcome (current)',type:'select',options:['open','won','lost'],optionLabels:{open:'Open',won:'Won',lost:'Lost'}},
 {id:'currentDealCloseDate',label:'Linked deal close date (current)',type:'date'},
 text('currentCompanyId','Deal primary company ID (current)'),text('currentCompanyName','Deal primary company (current)'),text('currentCompanyIndustry','Deal primary company industry (current)'),
 text('currentContactId','Deal primary contact ID (current)'),text('currentContactName','Deal primary contact (current)'),text('currentContactLifecycle','Deal primary contact lifecycle (current)'),
];
export const commerceCRMNote=' Linked CRM fields reflect the source deal and its primary company/contact now, not when the document was issued. Missing or replaced deals retain document values with blank CRM fields. A No value group can include an empty property, no source deal or an unavailable deal; group or filter by Source deal link to distinguish them. Primary links never multiply report rows; additional associations and deal amounts are excluded. To filter by sales owner, use Linked deal owner (current) in report filters; dashboard record-owner filters remain not applicable.';
