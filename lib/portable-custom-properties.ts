import {z} from 'zod';
import {filterFields,type FilterField} from './filters';
import {normalizePropertyOrganization,propertyGroupInput,type PropertyOrganization} from './property-groups';
import {customTextLimit,propertyTypeLabel} from './property-text';
import type {CustomValue} from './property-values';
import {standardFields} from './standard-properties';
import type {Property} from './workspace';

export const portableCustomPropertyKinds=z.enum(['contacts','companies','deals']);
export const portableCustomPropertyTypes=['text','textarea','number','checkbox','date','datetime','url','email','select','multiselect'] as const satisfies readonly Property['type'][];
export const portableCustomPropertyLimit=40;
export const portableCustomTextLimit=2000;
const id=z.string().guid("Invalid uuid");
const label=z.string().trim().min(1).max(80);
const type=z.enum(portableCustomPropertyTypes);

export const portableCustomPropertyRead=z.object({
  kind:portableCustomPropertyKinds,workspaceId:id.optional(),
}).strict();

export const portablePropertyGroupRead=portableCustomPropertyRead.pick({kind:true});
export const portablePropertyGroupWrite=propertyGroupInput.extend({
  kind:portableCustomPropertyKinds,revision:z.number().int().min(0).max(2147483646),
}).strict();
export type PortablePropertyGroupWrite=z.output<typeof portablePropertyGroupWrite>;

const audience=z.union([z.literal('workspace'),z.literal('owner'),id]);
export const portableCustomPropertyWrite=z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),kind:portableCustomPropertyKinds,label,type,audience:audience.optional(),
    options:z.array(z.string().trim().min(1).max(80)).max(50).default([])}).strict(),
  z.object({action:z.literal('access'),kind:portableCustomPropertyKinds,id,audience,expectedRevision:z.number().int().min(1).max(2147483646)}).strict(),
  z.object({action:z.literal('rename'),kind:portableCustomPropertyKinds,id,label,
    expectedRevision:z.number().int().min(1).max(2147483646)}).strict(),
]);

export const portableCustomPatch=z.record(id,z.union([
  z.string().max(customTextLimit),z.number().finite(),z.boolean(),z.array(z.string().trim().min(1).max(80)).max(50),z.null(),
]))
  .refine(value=>Object.keys(value).length<=portableCustomPropertyLimit);

export type PortableCustomPropertyKind=z.output<typeof portableCustomPropertyKinds>;
export type PortableCustomPropertyType=z.output<typeof type>;
export type PortableCustomPropertyWrite=z.output<typeof portableCustomPropertyWrite>;
export type PortableCustomPatch=z.output<typeof portableCustomPatch>;
export type PortableCustomValues=Record<string,CustomValue>;
export type PortableCustomProperty={
  id:string;kind:PortableCustomPropertyKind;label:string;type:PortableCustomPropertyType;options:string[];revision:number;audience?:string;
};

const portableGroupCoreFields={
  contacts:['name','owner','email','phone','title','lifecycle'],
  companies:['name','owner','domain','website','industry','city','lifecycle'],
  deals:['name','owner','amount','closeDate','stage','pipelineId'],
} satisfies Record<PortableCustomPropertyKind,string[]>;

export function portablePropertyGroupFields(kind:PortableCustomPropertyKind,
  properties:Pick<PortableCustomProperty,'id'|'label'|'type'|'options'>[]):FilterField[]{
  const core=filterFields(kind,[]).filter(field=>portableGroupCoreFields[kind].includes(field.id))
    .map(field=>field.id==='stage'||field.id==='pipelineId'?{...field,options:undefined,optionLabels:undefined}:field);
  const custom=properties.map(({id,label,type,options}):FilterField=>({
    id:'custom:'+id,label,type:type==='textarea'?'text':type,options,multiline:type==='textarea',
  }));
  return [...core,...standardFields(kind),...custom];
}

// Only serialize custom groups that contain a property this viewer may read.
export function visiblePropertyOrganization(kind:PortableCustomPropertyKind,properties:PortableCustomProperty[],config:PropertyOrganization):PropertyOrganization{
  const fields=portablePropertyGroupFields(kind,properties.filter(property=>property.kind===kind));
  const {assignments}=normalizePropertyOrganization(kind,fields,config);
  const assigned=new Set(Object.values(assignments));
  return {assignments,groups:config.groups.filter(group=>assigned.has(group.id))};
}

export const customPropertyTypeLabels:Record<PortableCustomPropertyType,string>={
  text:'Text',textarea:propertyTypeLabel('textarea'),number:'Number',checkbox:'Checkbox',date:'Date',
  datetime:propertyTypeLabel('datetime'),url:propertyTypeLabel('url'),email:propertyTypeLabel('email'),select:'Dropdown',
  multiselect:'Multi-select',
};
