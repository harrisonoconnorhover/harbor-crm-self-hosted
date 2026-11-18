import {and,ilike,sql,type SQLWrapper} from 'drizzle-orm';
import type {PortableSegmentDefinition} from '../../lib/portable-segments';
import {recordSearchPattern} from './record-search';

export function portableSegmentMatch(data:SQLWrapper,criteria:PortableSegmentDefinition['criteria']){
  const conditions=criteria.groups.flat().map(rule=>{
    const value=sql`${data}->>${rule.field}`;
    return rule.field==='lifecycle'?sql`lower(${value})=lower(${rule.value})`:ilike(value,recordSearchPattern(rule.value)!);
  });
  return and(...conditions)??sql`true`;
}
