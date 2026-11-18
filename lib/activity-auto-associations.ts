import {datedActivityTypes} from './activity-date-policy';
import {z} from 'zod';
import {kinds,type Kind} from './crm';
export const automaticActivityTypes=datedActivityTypes;
export const associationModes=['none','recent1','recent5','all'] as const;
const mode=z.enum(associationModes);
export const activityAssociationRuleSchema=z.object({
 source:z.enum(kinds),type:z.enum(automaticActivityTypes),
 contacts:mode,companies:z.enum([...associationModes,'primary']),deals:mode,tasks:mode,tickets:mode,leads:mode.default('none'),
}).strict().refine(r=>r.source!=='companies'||r.companies!=='primary','Companies do not have a primary company.');
export const activityAssociationRulesSchema=z.array(activityAssociationRuleSchema).max(kinds.length*automaticActivityTypes.length).refine(rows=>new Set(rows.map(r=>r.source+':'+r.type)).size===rows.length,'Set one rule per source object and activity type.');
export type ActivityAssociationRule=z.infer<typeof activityAssociationRuleSchema>;
export function defaultActivityAssociationRule(source:Kind,type:ActivityAssociationRule['type']):ActivityAssociationRule{
 return {source,type,contacts:'none',companies:['contacts','deals','tickets'].includes(source)?'primary':'none',deals:['contacts','companies','deals'].includes(source)?'recent5':'none',tasks:'none',tickets:'none',leads:'none'};
}
export function activityAssociationRule(rows:ActivityAssociationRule[]|undefined,source:Kind,type:ActivityAssociationRule['type']){
 return rows?.find(r=>r.source===source&&r.type===type)??defaultActivityAssociationRule(source,type);
}
