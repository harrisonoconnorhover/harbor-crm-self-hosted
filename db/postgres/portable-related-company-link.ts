import {and,eq,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {companies} from './company-schema';
import {activeCompany} from './company-visibility';

export async function resolvePortableCompanyLink(db:Pick<PostgresJsDatabase,'select'>,workspaceId:string,
  priorId:string|null,requestedId:string|null|undefined){
  const id=requestedId===undefined?priorId:requestedId;
  if(!id)return {id:null,visibleId:null,name:null};
  // Company archive takes FOR UPDATE, so this waits for it and rechecks activity.
  const [company]=await db.select({name:sql<string>`${companies.data}->>'name'`}).from(companies)
    .where(and(eq(companies.workspaceId,workspaceId),eq(companies.id,id),activeCompany)).for('key share');
  // An omitted link keeps its stored value, even while archived. An explicit
  // assignment needs a currently active target, even if the ID is unchanged.
  if(!company&&requestedId!==undefined)return null;
  return {id,visibleId:company?id:null,name:company?.name??null};
}
