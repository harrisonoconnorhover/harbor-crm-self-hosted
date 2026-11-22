import {eq,sql} from 'drizzle-orm';
import {check,pgTable,text} from 'drizzle-orm/pg-core';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {loginIdentities} from './identity-schema';
import {maxPortableBookmarks,type PortableTool} from '../../lib/portable-nav-tools';

export const navigationBookmarks=pgTable('portable_navigation_bookmarks',{
  userId:text('user_id').primaryKey().references(()=>loginIdentities.id,{onDelete:'cascade'}),
  items:text('items').array().$type<PortableTool[]>().notNull(),
},t=>[check('portable_navigation_bookmark_limit',sql`cardinality(${t.items}) BETWEEN 0 AND 5`)]);

export async function readBookmarks(db:PostgresJsDatabase,userId:string){
  const [row]=await db.select({items:navigationBookmarks.items}).from(navigationBookmarks).where(eq(navigationBookmarks.userId,userId));
  return row?.items??[];
}

export async function setBookmark(db:PostgresJsDatabase,userId:string,tool:PortableTool,pin:boolean){
  const {items}=navigationBookmarks;
  const present=sql`${tool} = ANY(${items})`;
  const [row]=await db.insert(navigationBookmarks).values({userId,items:pin?[tool]:[]}).onConflictDoUpdate({
    target:navigationBookmarks.userId,
    set:{items:pin?sql`CASE WHEN ${present} THEN ${items} ELSE array_append(${items},${tool}::text) END`:
      sql`array_remove(${items},${tool}::text)`},
    setWhere:pin?sql`${present} OR cardinality(${items}) < ${maxPortableBookmarks}`:undefined,
  }).returning({items});
  return row?.items;
}
