import {z} from 'zod';
import {ApiError} from './api-error';
import {autoMap,MAX_IMPORT_ROWS,parseCSV,planImport} from './csv-import';
import {initialPipelineSettings,type PipelineSettings} from './forecast';
import {builtinPipeline,missingDealStageMessage,missingPortableDealStageFields,type DealPipeline,type PortableDealStageCustomField} from './portable-deal-pipelines';
import {portableCompanyFields,portableContactFields,portableDealFields,portableRecordKind,
  type CompanyFields,type ContactFields,type DealFields,type PortableRecordKind} from './portable-records';
import {portableCustomTextLimit,type PortableCustomProperty,type PortableCustomValues} from './portable-custom-properties';
import type {CustomValue} from './property-values';
import {standardFields} from './standard-properties';

export const portableCsvBytes=250_000;
export type PortableImportKind=PortableRecordKind|'paired';
const names={contacts:'Contacts',companies:'Companies',deals:'Deals',paired:'Contacts and Companies'} satisfies Record<PortableImportKind,string>;
const baseFields={
  contacts:[['name','Name'],['email','Email'],['phone','Phone'],['title','Job title'],['lifecycle','Lifecycle stage'],['primaryCompanyId','Primary company (Record ID)']],
  companies:[['name','Name'],['domain','Domain'],['website','Website'],['industry','Industry'],['city','City'],['lifecycle','Lifecycle stage']],
  deals:[['name','Name'],['amount','Amount'],['pipelineId','Pipeline'],['stage','Deal stage'],['closeDate','Close date']],
} as const;

export const portableImportName=(kind:PortableImportKind)=>names[kind];
export const portableImportFields=(kind:PortableRecordKind,properties:PortableCustomProperty[]=[],reviewMatches=false)=>[
  ...(reviewMatches?[['recordId','Record ID'] as const]:[]),
  ...baseFields[kind],...standardFields(kind).map(field=>[field.id,field.label] as const),
  ...properties.filter(property=>property.kind===kind).map(property=>['custom:'+property.id,property.label] as const),
];
const csv=z.string().min(1).max(portableCsvBytes);
const kind=portableRecordKind.or(z.literal('paired')).default('contacts');
const mapping=z.array(z.string().max(100)).min(1).max(100).optional();
export const portableRecordImportRequest=z.discriminatedUnion('action',[
  z.object({action:z.literal('columns'),kind,csv,reviewMatches:z.literal(true).optional()}).strict(),
  z.object({action:z.literal('preview'),kind,csv,mapping,reviewMatches:z.literal(true).optional()}).strict(),
  z.object({action:z.literal('import'),kind,csv,mapping,reviewMatches:z.literal(true).optional(),
    updateRows:z.array(z.number().int().min(2).max(MAX_IMPORT_ROWS+1)).max(MAX_IMPORT_ROWS)
      .refine(rows=>new Set(rows).size===rows.length).optional(),includeNew:z.boolean().optional(),
    requestId:z.string().guid("Invalid uuid"),review:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict(),
]).refine(input=>(!input.reviewMatches||input.kind!=='paired')&&
  (input.action!=='import'||input.reviewMatches||(input.updateRows===undefined&&input.includeNew===undefined)));

export type RecordImportCommit=Extract<z.output<typeof portableRecordImportRequest>,{action:'import'}>;
export type RecordImportResult={created:number;skipped:number;updated?:number;paired?:{contacts:number;companies:number;reusedCompanies:number}};
export type RecordCsvChange={field:string;label:string;before:CustomValue|null;after:CustomValue};
export type RecordCsvUpdate={row:number;state:'update';name:string;email?:string;identifier?:string;changes:RecordCsvChange[]};
export type RecordImportRow<T>={row:number}&({state:'create';data:T}|{state:'skip'|'error';message:string});
type ImportColumn={header:string;field:string|null};
export type PortableCsvColumn={header:string;target:string};
export type RecordImportPreview={
  review:string;columns:ImportColumn[];created:number;skipped:number;errors:number;updates?:number;paired?:RecordImportResult['paired'];
  rows:({row:number;object?:'Contact'|'Company'}&({state:'create';name:string;email?:string;domain?:string;pipeline?:string;stage?:string;company?:string;custom?:{label:string;value:CustomValue}[]}|
    RecordCsvUpdate|{state:'skip'|'error';message:string}))[];
};

type DealImportData={data:DealFields;pipelineId:string|null;stageId:string|null;pipelineName:string};
export type ContactImportFields=ContactFields&{importCompany?:{id:string;name:string}};
type Rows<T>={columns:ImportColumn[];rows:RecordImportRow<T>[]};
export type PreparedRecordCsv=
  ({kind:'contacts'}&Rows<ContactImportFields>)|({kind:'companies'}&Rows<CompanyFields>)|({kind:'deals'}&Rows<DealImportData>);

export function mapPortableRecordCsv(object:PortableRecordKind,text:string,requested?:string[],properties:PortableCustomProperty[]=[],
  suggestCustom=false,reviewMatches=false){
  try{
    const {headers,rows,historyColumns}=parseCSV(text,{maxRows:MAX_IMPORT_ROWS,maxBytes:portableCsvBytes});
    if(historyColumns?.length)throw Error('Choose record values for this import. Property history columns are unsupported.');
    const fields=new Map(portableImportFields(object,properties,reviewMatches));
    const automatic=autoMap(headers,object,[]).map(key=>key!=='primaryCompanyId'&&fields.has(key)?key:'');
    if(object==='deals'&&!automatic.includes('stage')){
      const stageId=headers.findIndex(header=>header.toLowerCase().replace(/[^a-z0-9]/g,'')==='stageid');
      if(stageId>=0)automatic[stageId]='stage';
    }
    // Existing callers and import receipts keep the original automatic mapping.
    const suggested=suggestCustom?autoMap(headers,object,properties).map((key,index)=>
      automatic[index]||(key.startsWith('custom:')&&fields.has(key)?key:'')):automatic;
    const mapping=requested??suggested;
    if(mapping.length!==headers.length)throw Error('Choose a mapping for each CSV column.');
    const targets=mapping.filter(Boolean);
    if(targets.some(target=>!fields.has(target)))throw Error('A mapped property is unavailable for this import.');
    if(new Set(targets).size!==targets.length)throw Error('Map each property only once.');
    const selectedProperties=properties.filter(property=>targets.includes('custom:'+property.id));
    return {headers,rows,fields,mapping,properties:selectedProperties,remapped:mapping.some((target,index)=>target!==automatic[index])};
  }catch(error){
    throw new ApiError(400,error instanceof Error?error.message:'Check the CSV.');
  }
}
export type MappedRecordCsv=ReturnType<typeof mapPortableRecordCsv>;

function parseRows<T>(object:PortableRecordKind,source:MappedRecordCsv,validate:(fields:Record<string,unknown>,custom:PortableCustomValues|undefined)=>T|undefined,
  dealStages?:PipelineSettings):Rows<T>{
  const {headers,rows,fields,mapping}=source;
  try{
    // The portable store resolves the relationship against its scoped Company table.
    const recordMapping=mapping.map(key=>key==='primaryCompanyId'||key==='recordId'?'':key);
    const planned=planImport(rows,recordMapping,object,source.properties,[],dealStages).map((row):RecordImportRow<T>=>{
      if(row.error)return {row:row.row,state:'error',message:row.error};
      if(row.skipped||!row.data)return {row:row.row,state:'skip',message:row.skipped??'No new record to import.'};
      const custom=row.data.custom??{};
      const overlong=source.properties.find(({id,type})=>
        type==='text'&&typeof custom[id]==='string'&&custom[id].length>portableCustomTextLimit);
      if(overlong)return {row:row.row,state:'error',message:`Use up to ${portableCustomTextLimit} characters for ${overlong.label}.`};
      const data=validate(Object.fromEntries(Object.entries(row.data).filter(([key])=>fields.has(key))),
        Object.keys(custom).length?custom:undefined);
      return data?{row:row.row,state:'create',data}:{row:row.row,state:'error',message:'Check the record fields.'};
    });
    return {columns:headers.map((header,index)=>({header,field:fields.get(mapping[index])??null})),rows:planned};
  }catch(error){
    throw new ApiError(400,error instanceof Error?error.message:'Check the CSV.');
  }
}

export function preparePortableRecordCsv(object:PortableRecordKind,source:MappedRecordCsv,customPipelines:DealPipeline[]=[],
  stageCustomFields:PortableDealStageCustomField[]=[],matchedDeals?:ReadonlySet<number>):PreparedRecordCsv{
  if(object==='contacts')return {kind:object,...parseRows(object,source,(data,custom)=>{
    const parsed=portableContactFields.safeParse(data);
    return parsed.success?{...parsed.data,...(custom?{custom}:{})}:undefined;
  })};
  if(object==='companies')return {kind:object,...parseRows(object,source,(data,custom)=>{
    const parsed=portableCompanyFields.safeParse(data);
    return parsed.success?{...parsed.data,...(custom?{custom}:{})}:undefined;
  })};
  const pipelines=[builtinPipeline,...customPipelines];
  // Adapt only the catalog information the native CSV planner uses to match
  // a pipeline and stage, including its first stage when a cell is blank.
  const settings:PipelineSettings={...initialPipelineSettings,pipelines:pipelines.map(pipeline=>({
    id:pipeline.id,name:pipeline.name,probabilities:{},
    stageOrder:pipeline.stages.map(stage=>stage.id),
    stageLabels:Object.fromEntries(pipeline.stages.map(stage=>[stage.id,stage.name])),
  }))};
  const prepared=parseRows(object,source,(fields,custom)=>{
    const {pipelineId,...data}=fields;
    const pipeline=pipelines.find(pipeline=>pipeline.id===pipelineId);
    const stage=pipeline?.stages.find(stage=>stage.id===data.stage);
    if(!pipeline||!stage)return undefined;
    const parsed=portableDealFields.safeParse({...data,stage:stage.name});
    if(!parsed.success)return undefined;
    const isBuiltin=pipeline.id===builtinPipeline.id;
    return {data:{...parsed.data,...(custom?{custom}:{})},pipelineId:isBuiltin?null:pipeline.id,stageId:isBuiltin?null:stage.id,pipelineName:pipeline.name};
  },settings);
  return {kind:object,columns:prepared.columns,rows:prepared.rows.map(row=>{
    if(row.state!=='create'||!row.data.pipelineId||matchedDeals?.has(row.row))return row;
    const stage=pipelines.find(pipeline=>pipeline.id===row.data.pipelineId)?.stages.find(item=>item.id===row.data.stageId);
    const missing=missingPortableDealStageFields(stage?.requiredProperties,row.data.data,undefined,stageCustomFields);
    return missing.length?{row:row.row,state:'error',message:missingDealStageMessage(row.data.data.stage,missing)}:row;
  })};
}
