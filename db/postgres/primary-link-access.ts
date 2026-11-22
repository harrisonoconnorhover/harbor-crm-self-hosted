import {and,eq,inArray} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {ownedRecordScope} from './record-ownership-scope';

// Called inside the workspace write lock. A replacement also removes the old relationship.
export async function canChangePrimaryLink(db:PostgresJsDatabase,actorId:string,workspaceId:string,
  table:typeof companies|typeof contacts,previous:string|null,next:string|null|undefined){
  if(next===undefined||next===previous)return true;
  const ids=[previous,next].filter((id):id is string=>id!==null);
  const eligible=await db.select({id:table.id}).from(table).where(and(eq(table.workspaceId,workspaceId),
    inArray(table.id,ids),ownedRecordScope(db,actorId,workspaceId,table,'edit')));
  return eligible.length===ids.length;
}
