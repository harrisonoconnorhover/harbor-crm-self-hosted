import { z } from 'zod';
import { InputError, type Property } from './workspace';
import { propertyDateTimeSchema } from './property-datetime';
import { stageRuleConditionSchema, type StageRuleCondition } from './stage-property-rules';

// Infer comparison type from the authoritative property definition, not a
// caller-supplied hint. Store it with the rule so form previews and enforcement
// share instant comparison without loading another property catalog.
export function normalizePropertyCondition(input:StageRuleCondition,fields:Property[]):StageRuleCondition {
 const condition=stageRuleConditionSchema.parse(input),field=fields.find(f=>f.id===condition.field);
 if(!field||!['select','multiselect','checkbox','date','datetime'].includes(field.type))throw new InputError('Choose an available dropdown, checkbox, date or date-and-time controlling property.');
 if(['before','after'].includes(condition.operator)&&!['date','datetime'].includes(field.type))throw new InputError('Before and after conditions need a date or date-and-time property.');
 const {valueType:_,...base}=condition;
 if(field.type==='datetime'){
  if(condition.values.length>1)throw new InputError('Choose one date and time per condition.');
  const values=condition.values.map(v=>{
   const parsed=propertyDateTimeSchema.safeParse(v);
   if(!parsed.success)throw new InputError(`Choose a valid date and time with a time zone for ${field.label}.`);
   return parsed.data;
  });
  return {...base,valueType:'datetime',values:[...new Set(values)]};
 }
 if(condition.values.some(v=>field.type==='checkbox'?typeof v!=='boolean':field.type==='date'?!z.string().date().safeParse(v).success:typeof v!=='string'||!field.options.includes(v)))throw new InputError(`Choose valid condition values for ${field.label}.`);
 return base;
}
