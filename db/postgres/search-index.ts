import {or,sql,type SQLWrapper} from 'drizzle-orm';
import {index} from 'drizzle-orm/pg-core';

// Fold each scalar with the same Unicode rules as the final per-property search.
export const indexedRecordValues=(data:SQLWrapper)=>sql`(public.harbor_search_values(${data}) COLLATE "C")`;

export function customIdentifierIndex(name:string,data:SQLWrapper,archivedAt:SQLWrapper){
  return index(name).using('gin',sql`(${data}->'custom') jsonb_path_ops`)
    .where(sql`${archivedAt} IS NULL AND (${data}->'custom') IS NOT NULL`);
}

export function recordSearchIndex(name:string,data:SQLWrapper,archivedAt?:SQLWrapper){
  const definition=index(name).using('gin',sql`${indexedRecordValues(data)} public.gin_trgm_ops`);
  return archivedAt?definition.where(sql`${archivedAt} IS NULL`):definition;
}

// Match each list's existing ILIKE expressions and database collation. A multi-column
// GIN index can serve either field independently when the list searches both.
export function listSearchIndex(name:string,first:SQLWrapper,...rest:SQLWrapper[]){
  const trigram=(field:SQLWrapper)=>sql`(${field}) public.gin_trgm_ops`;
  return index(name).using('gin',trigram(first),...rest.map(trigram));
}

export function activeListSearchIndex(name:string,archivedAt:SQLWrapper,first:SQLWrapper,...rest:SQLWrapper[]){
  return listSearchIndex(name,first,...rest).where(sql`${archivedAt} IS NULL`);
}

export const literalSearchPattern=(value:string)=>'%'+value.replace(/[\\%_]/g,character=>'\\'+character)+'%';

// Preserve literal short searches when the text has no three-character index key.
export function recordSearchCandidate(data:SQLWrapper,query:string){
  return /[\p{L}\p{N}]{3}/u.test(query)
    ?sql`${indexedRecordValues(data)} LIKE lower(${literalSearchPattern(query)}::text COLLATE pg_catalog.pg_unicode_fast) COLLATE "C"`
    :undefined;
}

// Confirm the substring inside one value so adjacent fields cannot produce a match.
export function recordValueContains(data:SQLWrapper,query:string){
  return sql`EXISTS (
    SELECT 1 FROM jsonb_path_query(${data},
      'strict $.** ? (@.type() != "object" && @.type() != "array" && @.type() != "null")') AS property(value)
    WHERE strpos(lower((property.value #>> '{}') COLLATE pg_catalog.pg_unicode_fast),
      lower(${query}::text COLLATE pg_catalog.pg_unicode_fast))>0
  )`;
}

function searchableText(fields:SQLWrapper[]){
  const folded=fields.map(field=>sql`coalesce(lower(${field}),'')`);
  return sql`((${sql.join(folded,sql` || chr(31) || `)}) COLLATE "C")`;
}

export function textFieldsSearchIndex(name:string,fields:SQLWrapper[]){
  return index(name).using('gin',sql`${searchableText(fields)} public.gin_trgm_ops`);
}

export function matchesTextFields(fields:SQLWrapper[],query:string|undefined){
  if(!query)return undefined;
  // Short terms lack a useful trigram. If a term contains our separator, check each
  // field independently so a match cannot span two different property values.
  if(query.includes('\u001f')||!/[\p{L}\p{N}]{3}/u.test(query)){
    return or(...fields.map(field=>sql`strpos(lower(${field}),lower(${query}))>0`));
  }
  return sql`${searchableText(fields)} LIKE (lower(${literalSearchPattern(query)}::text) COLLATE "C")`;
}

export const wordSearchDocument=(field:SQLWrapper)=>sql`to_tsvector('simple'::regconfig, ${field})`;

export const matchesSearchWords=(field:SQLWrapper,query:string)=>sql`${wordSearchDocument(field)} @@ plainto_tsquery('simple'::regconfig,${query})`;
