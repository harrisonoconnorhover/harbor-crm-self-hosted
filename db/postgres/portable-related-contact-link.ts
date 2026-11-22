import {ownedRecordScope} from './record-ownership-scope';
import {and,eq,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {ContactFields} from '../../lib/portable-records';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';

export async function resolvePortableContactLink(db:Pick<PostgresJsDatabase,'select'>,workspaceId:string,
  priorId:string|null,requestedId:string|null|undefined,sharedActorId?:string){
  const id=requestedId===undefined?priorId:requestedId;
  if(!id)return {id:null,visibleId:null,name:null,lifecycle:null};
  const [contact]=await db.select({name:sql<string>`${contacts.data}->>'name'`,
    lifecycle:sql<ContactFields['lifecycle']|null>`${contacts.data}->>'lifecycle'`}).from(contacts)
    .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,id),activeContact,sharedActorId?ownedRecordScope(db,sharedActorId,workspaceId,contacts):undefined)).for('share');
  // An omitted link keeps its stored value. An explicit assignment needs a
  // currently visible target, even if the caller supplied the same ID.
  if(!contact&&requestedId!==undefined)return null;
  return {id,visibleId:contact?id:null,name:contact?.name??null,lifecycle:contact?.lifecycle??null};
}
