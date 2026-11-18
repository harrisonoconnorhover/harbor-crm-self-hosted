import {normalizedValidation,type ValidationRules} from './property-validation';
import { z } from 'zod';
import { kinds } from './crm';
import type { Property } from './workspace';
export type DefinitionSnapshot={showRelativeTime?:boolean;linkText?:string;allowCustomLinkText?:boolean;uniqueValues?:boolean;validation?:ValidationRules;archivedAt?:string|null;label:string;description:string;type:Property['type'];options:string[]};
export function definitionSnapshot(p:Pick<Property,'label'|'description'|'type'|'options'|'archivedAt'|'validation'|'uniqueValues'|'linkText'|'allowCustomLinkText'|'showRelativeTime'>):DefinitionSnapshot {
 const validation=normalizedValidation(p.validation);
 return {...(['date','datetime'].includes(p.type)?{showRelativeTime:!!p.showRelativeTime}:{}),...(p.type==='url'?{linkText:p.linkText||'',allowCustomLinkText:!!p.allowCustomLinkText}:{}),...(p.uniqueValues?{uniqueValues:true}:{}),...(validation?{validation}:{}),label:p.label,description:p.description||'',type:p.type,options:p.options,...(p.archivedAt?{archivedAt:p.archivedAt}:{})};
}
export type DefinitionHistoryItem={id:string;revision:number;action:string;changedAt:string;changedBy:string;before:DefinitionSnapshot|null;after:DefinitionSnapshot};
export type DefinitionHistoryPage={property:Property;items:DefinitionHistoryItem[];next:number|null;created:{at:string;by:string}|null};
export const definitionHistoryQuery=z.object({kind:z.enum(kinds),id:z.string().guid("Invalid uuid").optional(),field:z.string().min(1).max(150).optional(),before:z.coerce.number().int().positive().optional()}).refine(q=>!!q.id!==!!q.field,'Choose one property ID or standard field.');
