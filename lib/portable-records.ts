import {z} from 'zod';
import {schemas,stages} from './crm';
import {extensionSchemas} from './standard-properties';
import {pipelineKey,type PipelineStage} from './portable-deal-pipelines';
import {portableCustomPatch,portableCustomPropertyKinds,type PortableCustomValues} from './portable-custom-properties';

export const portableContactFields=z.object({...extensionSchemas.contacts,city:extensionSchemas.contacts.city as z.ZodOptional<z.ZodString>,
  ...schemas.contacts.pick({name:true,email:true,phone:true,title:true,lifecycle:true}).shape}).strict();
export const portableCompanyFields=z.object({...extensionSchemas.companies,
  ...schemas.companies.pick({name:true,domain:true,website:true,industry:true,city:true,lifecycle:true}).shape}).strict();
export const portableDealFields=z.object({...extensionSchemas.deals,...schemas.deals.pick({name:true,amount:true,closeDate:true}).shape,
  stage:z.string().trim().min(1).max(80).default(stages[0])}).strict();
const customPatch={custom:portableCustomPatch.optional()};
const assignment={assigneeId:z.string().min(1).max(200).nullable().optional()};
const recordId=z.string().guid("Invalid uuid");
const builtinStage=z.enum(stages);
export const dealCloseMonth=z.union([z.literal('undated'),z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/)]);
export const portableRecordKind=portableCustomPropertyKinds;
export type PortableRecordKind=z.infer<typeof portableRecordKind>;
export const portableRecordLabels={contacts:'Contact',companies:'Company',deals:'Deal'} satisfies Record<PortableRecordKind,string>;

export function writeSchema<S extends z.ZodRawShape>(save:z.ZodObject<S>){
  return z.union([
    save.extend({id:recordId,expectedRevision:z.number().int().min(1).max(2147483646)}).strict(),
    save.strict(),
  ]);
}
const contactWrite=writeSchema(z.object({action:z.literal('save'),kind:z.literal('contacts'),...assignment,data:portableContactFields.extend(customPatch),primaryCompanyId:recordId.nullable().optional()}));
export const portableContactTextFields=['name','email','phone','title','city'] as const;
export type PortableContactTextField=typeof portableContactTextFields[number];
export const portableContactTextPatch=z.object({
  action:z.literal('patchContactText'),id:recordId,expectedRevision:z.number().int().min(1).max(2147483646),
  field:z.enum(portableContactTextFields),value:z.string().max(2048).nullable(),
}).strict();
const companyWrite=writeSchema(z.object({action:z.literal('save'),kind:z.literal('companies'),...assignment,data:portableCompanyFields.extend(customPatch)}));
const dealWrite=writeSchema(z.object({action:z.literal('save'),kind:z.literal('deals'),...assignment,data:portableDealFields.extend(customPatch),
  pipelineId:recordId.nullable().optional(),stageId:recordId.nullable().optional(),
  companyId:recordId.nullable().optional(),primaryContactId:recordId.nullable().optional()}));
export const portableRecordWrite=z.union([contactWrite,companyWrite,dealWrite]);
export const recordSearchLimit=120;
export const portableRecordSearch=z.string().trim().min(1).max(recordSearchLimit);
export const portableContactSort=z.enum(['outreach-newest','outreach-oldest']);
export function readContactOutreachCursor(value:string){
  const [id,stamp,...rest]=value.split(':');
  if(rest.length||!recordId.safeParse(id).success)return undefined;
  if(stamp==='none')return {id,at:null};
  if(!/^[1-9]\d{0,14}$/.test(stamp??'')||Number(stamp)>253402300799999)return undefined;
  return {id,at:Number(stamp)};
}
export const portableRecordReadFields=z.object({
  kind:portableRecordKind.default('contacts'),
  id:recordId.optional(),after:z.string().max(55).optional(),limit:z.coerce.number().int().min(1).max(50).default(25),
  sort:portableContactSort.optional(),
  search:portableRecordSearch.optional(),owner:z.union([z.enum(['mine','unassigned','unavailable']),z.string().guid("Invalid uuid").toLowerCase()]).optional(),
  stage:z.string().min(1).max(80).optional(),pipelineId:pipelineKey.optional(),closeMonth:dealCloseMonth.optional(),
  workspaceId:recordId.optional(),
  companyId:recordId.optional(),primaryContactId:recordId.optional(),
}).strict();
export const portableRecordRead=portableRecordReadFields.refine(input=>!(input.id&&(input.after||input.sort||input.search||input.owner||input.stage||input.pipelineId||input.closeMonth||input.companyId||input.primaryContactId))&&
  (!input.sort||input.kind==='contacts')&&
  (input.after===undefined||(input.sort?!!readContactOutreachCursor(input.after):recordId.safeParse(input.after).success))&&
  (!input.companyId||input.kind!=='companies')&&(!input.primaryContactId||(input.kind==='deals'&&!input.companyId))&&
  (!(input.stage||input.pipelineId||input.closeMonth)||input.kind==='deals')&&
  (!input.stage||(input.pipelineId&&input.pipelineId!=='default'?recordId.safeParse(input.stage).success:builtinStage.safeParse(input.stage).success)));
export type PortableRecordQuery=z.output<typeof portableRecordRead>;
export type PortableRecordOwner={userId:string;workspaceId:string;label:string};
type ManagedRecordFields={custom?:PortableCustomValues;recordOwner?:PortableRecordOwner};
export type ContactFields=z.output<typeof portableContactFields>&ManagedRecordFields;
export type CompanyFields=z.output<typeof portableCompanyFields>&ManagedRecordFields;
export type DealFields=z.output<typeof portableDealFields>&ManagedRecordFields;
export type ContactWrite=z.output<typeof contactWrite>;
export type ContactTextWrite=Omit<Extract<ContactWrite,{id:string}>,'data'>&{
  data:Partial<Record<PortableContactTextField,string>>&{custom?:never};
};
export type CompanyWrite=z.output<typeof companyWrite>;
export type DealWrite=z.output<typeof dealWrite>;
type PortableRecord<Fields>={id:string;revision:number;data:Fields;createdAt:string;updatedAt:string};
export type ContactRecord=PortableRecord<ContactFields>&{primaryCompanyId:string|null;primaryCompanyName:string|null};
export type CompanyRecord=PortableRecord<CompanyFields>;
export type DealRecord=PortableRecord<DealFields>&{
  pipelineId:string|null;stageId:string|null;pipelineName:string;stageName:string;
  companyId:string|null;companyName:string|null;primaryContactId:string|null;primaryContactName:string|null;
};
export type PortableDealLane={stage:PipelineStage;cards:DealRecord[];more:boolean};

export type DealStageTotals={stageId:string|null;dealCount:number;amount:`${number}`;weightedOpen:`${number}`};
