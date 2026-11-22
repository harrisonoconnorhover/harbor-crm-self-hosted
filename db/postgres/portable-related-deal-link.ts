import {ownedRecordScope} from './record-ownership-scope';
import {and,eq,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {deals} from './deal-schema';
import {activeDeal} from './deal-visibility';

export async function resolvePortableDealLink(db:Pick<PostgresJsDatabase,'select'>,workspaceId:string,
  priorId:string|null,requestedId:string|null|undefined,sharedActorId?:string){
  const id=requestedId===undefined?priorId:requestedId;
  if(!id)return {id:null,visibleId:null,name:null};
  // Deal archive takes FOR UPDATE, so this waits for it and rechecks activity.
  const [deal]=await db.select({name:sql<string>`${deals.data}->>'name'`}).from(deals)
    .where(and(eq(deals.workspaceId,workspaceId),eq(deals.id,id),activeDeal,sharedActorId?ownedRecordScope(db,sharedActorId,workspaceId,deals):undefined)).for('key share');
  // An omitted link keeps its stored value, even while archived. An explicit
  // assignment needs a currently active target, even if the ID is unchanged.
  if(!deal&&requestedId!==undefined)return null;
  return {id,visibleId:deal?id:null,name:deal?.name??null};
}
