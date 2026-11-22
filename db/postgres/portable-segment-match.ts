import {and,ilike,or,sql,type SQLWrapper} from 'drizzle-orm';
import type {PortableSegmentDefinition} from '../../lib/portable-segments';
import {isRestrictableStandardField} from '../../lib/portable-standard-property-access';
import {recordSearchPattern} from './record-search';

const contactField={
  name:(data:SQLWrapper)=>sql`${data}->>'name'`,
  email:(data:SQLWrapper)=>sql`${data}->>'email'`,
  lifecycle:(data:SQLWrapper)=>sql`${data}->>'lifecycle'`,
};

export function portableSegmentMatch(data:SQLWrapper,criteria:PortableSegmentDefinition['criteria'],visibleData?:SQLWrapper){
  const groups=criteria.groups.map(group=>and(...group.map(rule=>{
    // Match the contact index expressions for public fields. A restricted field
    // must be evaluated against the same redacted data as the teammate's record.
    const source=visibleData&&isRestrictableStandardField('contacts',rule.field)?visibleData:data;
    const value=contactField[rule.field](source);
    return rule.field==='lifecycle'?sql`lower(${value})=lower(${rule.value})`:ilike(value,recordSearchPattern(rule.value)!);
  })));
  return or(...groups)??sql`true`;
}
