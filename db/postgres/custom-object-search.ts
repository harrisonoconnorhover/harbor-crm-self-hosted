import {and,ilike,or,sql} from 'drizzle-orm';
import {objectRecords} from './custom-object-schema';
import {literalSearchPattern,recordSearchCandidate,recordValueContains} from './search-index';

export function customRecordMatches(query:string){
  const values=sql`${objectRecords.data}->'values'`;
  // The record displays stored booleans as Yes and No.
  const checkbox=query.toLowerCase();
  const checkboxMatch=checkbox==='yes'?sql`${values} @? '$.* ? (@ == true)'`:
    checkbox==='no'?sql`${values} @? '$.* ? (@ == false)'`:undefined;
  return or(ilike(objectRecords.name,literalSearchPattern(query)),checkboxMatch,
    and(recordSearchCandidate(values,query),recordValueContains(values,query)))!;
}
