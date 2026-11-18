import {z} from 'zod';

export const portableCodeInputFields=['name','email','phone','title','lifecycle'] as const;
export const portableCodeOutputTypes=['string','number','boolean'] as const;
export const portableCodeLimit=4000;
const key=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/)
  .refine(value=>value!=='constructor'&&value!=='prototype');
const input=z.object({name:key,field:z.enum(portableCodeInputFields)}).strict();
const output=z.object({name:key,type:z.enum(portableCodeOutputTypes)}).strict();
const uniqueNames=(items:readonly {name:string}[])=>new Set(items.map(item=>item.name)).size===items.length;

export const portableManualCodeDefinition=z.object({
  name:z.string().trim().min(1).max(80),trigger:z.literal('manual_contact'),actionKind:z.literal('code'),
  delayMinutes:z.literal(0).default(0),code:z.string().trim().min(1).max(portableCodeLimit),
  inputs:z.array(input).max(5).refine(uniqueNames),
  outputs:z.array(output).min(1).max(8).refine(uniqueNames),
}).strict();

export type PortableCodeDefinition=z.output<typeof portableManualCodeDefinition>;
export type PortableCodeOutput=Record<string,string|number|boolean>;
export type PortableCodePayload=Pick<PortableCodeDefinition,'code'|'outputs'>&{inputFields:Record<string,string>};

const outputValues={string:z.string().max(1000),number:z.number().finite(),boolean:z.boolean()};

export function portableCodeOutput(value:Record<string,unknown>,declared:PortableCodeDefinition['outputs']):PortableCodeOutput|undefined{
  if(Object.keys(value).length!==declared.length)return undefined;
  const validated:PortableCodeOutput={};
  for(const {name,type} of declared){
    if(!Object.hasOwn(value,name))return undefined;
    const result=outputValues[type].safeParse(value[name]);
    if(!result.success)return undefined;
    validated[name]=result.data;
  }
  return validated;
}
