import {and,eq,inArray,isNotNull,sql,type SQL,type SQLWrapper} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {duplicateDomain,duplicateCompanySuffixes,type DuplicateKind} from '../../lib/duplicates';
import {contacts} from './contact-schema';
import {companies} from './company-schema';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {ownedRecordScope} from './record-ownership-scope';

const suffixPattern='('+duplicateCompanySuffixes.join('|')+')+$';
// The four groups partition the ASCII characters kept by nameBucket.
const letterGroups=['aeimquy26','bfjnrvz37','cgkosw048','dhlptx159'];
const ignoredPairs=letterGroups.flatMap((group,i)=>letterGroups.slice(i+1).map(other=>group+other));

type Db=Pick<PostgresJsDatabase,'select'|'selectDistinct'>;
export function eligibleDuplicateRows(db:Db,workspaceId:string,kind:DuplicateKind,scopedEditor?:string){
  const table=kind==='contacts'?contacts:companies;
  return and(eq(table.workspaceId,workspaceId),kind==='contacts'?activeContact:activeCompany,
    scopedEditor?ownedRecordScope(db,scopedEditor,workspaceId,table,'edit'):undefined);
}

// These deliberately broad keys only rule OUT singleton groups. Harbor's shared rules
// still decide every score and reason, including punctuation, accents and transpositions.
function nameBucket(value:SQLWrapper,company=false){
  const plain=sql`CASE WHEN ${value} COLLATE "C" !~ '[^A-Za-z0-9 ]'
    THEN lower(replace(${value},' ','') COLLATE "C")
    ELSE regexp_replace(lower(normalize(${value},NFKD) COLLATE pg_catalog.pg_unicode_fast) COLLATE "C",'[^a-z0-9]','','g') END`;
  return company?sql`regexp_replace(${plain},${suffixPattern},'')`:plain;
}
function domainBucket(value:SQLWrapper){
  // Numeric final labels, Unicode, escaped hosts and other URL spellings go through the JS URL parser.
  return sql`regexp_replace(substring(lower(${value} COLLATE "C") from
    '^(?:https?://)?((?:[a-z0-9-]+[.])+[a-z][a-z0-9-]*)[.]?(?::[0-9]+)?(?:[/?#].*)?$'),'^www[.]','')`;
}

// Match the scorer's literal substring on ASCII values. Keep non-ASCII values as
// possible hits: JavaScript and the database can use different Unicode case mappings.
function possibleSearchHit(field:SQLWrapper,needle:string){
  return sql`(octet_length(${field})<>length(${field}) OR strpos(lower((${field}) COLLATE "C"),${needle})>0)`;
}

async function unusualDomainPeers(db:Db,eligible:SQL|undefined,domain:SQL,hit:SQL|undefined){
  // Only unusual spellings on a possible hit need their canonical peers looked up.
  const maxDomainExceptions=256;
  const exceptions=await db.selectDistinct({domain:sql<string>`${domain}`}).from(companies)
    .where(and(eligible,isNotNull(domain),hit,sql`${domainBucket(domain)} IS NULL`)).limit(maxDomainExceptions+1);
  if(exceptions.length>maxDomainExceptions)return sql`has_domain`;
  const canonical=[...new Set(exceptions.map(row=>duplicateDomain(row.domain)).filter(Boolean))];

  // Either side may contain the search text. An ordinary hit may have a partner
  // only the URL parser recognizes (for example an escaped or internationalized host).
  const irregular=sql`has_domain AND identity_key IS NULL`;
  const peers=hit?sql`((${irregular}) AND EXISTS (SELECT 1 FROM hits WHERE has_domain))
    OR (has_domain AND search_hit AND EXISTS (SELECT 1 FROM blocks WHERE ${irregular}))`:irregular;
  return canonical.length?sql`(${peers}) OR ${inArray(sql<string>`identity_key`,canonical)}`:peers;
}

export async function suggestedCandidateIds(db:Db,workspaceId:string,kind:DuplicateKind,scopedEditor?:string,query=''){
  const eligible=eligibleDuplicateRows(db,workspaceId,kind,scopedEditor);
  const table=kind==='contacts'?contacts:companies;
  const needle=query.trim().toLowerCase();
  const identityField=kind==='contacts'?sql`${contacts.data}->>'email'`:sql`${companies.data}->>'domain'`;
  const hit=needle?sql`(${possibleSearchHit(sql`${table.data}->>'name'`,needle)} OR ${possibleSearchHit(identityField,needle)})`:undefined;
  const projectedHit=(hit??sql`true`).as('search_hit');
  const domain=sql`nullif(${companies.data}->>'domain','')`;
  const compactName=nameBucket(sql`${table.data}->>'name'`);
  const email=sql`nullif(${contacts.data}->>'email','')`;
  const projection=kind==='contacts'
    ?db.select({id:contacts.id,search_hit:projectedHit,compact_name:compactName.as('compact_name'),
      identity_key:sql`CASE WHEN ${email} COLLATE "C" !~ '[^!-~]' THEN lower(${email} COLLATE "C")
        ELSE regexp_replace(lower(${email} COLLATE pg_catalog.pg_unicode_fast) COLLATE "C",'[^!-~]','','g') END`.as('identity_key'),
      support_key:nameBucket(sql`${companies.data}->>'name'`,true).as('support_key'),has_domain:sql`false`.as('has_domain'),
    }).from(contacts).leftJoin(companies,and(eq(contacts.workspaceId,companies.workspaceId),eq(contacts.primaryCompanyId,companies.id),
      activeCompany,scopedEditor?ownedRecordScope(db,scopedEditor,workspaceId,companies):undefined)).where(eligible)
    :db.select({id:companies.id,search_hit:projectedHit,compact_name:compactName.as('compact_name'),identity_key:domainBucket(domain).as('identity_key'),
      support_key:nameBucket(sql`nullif(${companies.data}->>'city','')`).as('support_key'),has_domain:sql`${domain} IS NOT NULL`.as('has_domain'),
    }).from(companies).where(eligible);
  const uncommon=kind==='companies'?await unusualDomainPeers(db,eligible,domain,hit):sql`false`;
  const hasHit=needle?sql`AND bool_or(search_hit)`:sql``;
  const hits=needle?sql`hits AS MATERIALIZED (SELECT name_key,identity_key,support_key,has_domain FROM blocks WHERE search_hit),`:sql``;
  const relevantKey=(key:'name_key'|'support_key'|'identity_key')=>needle?
    sql`AND ${sql.identifier(key)} IN (SELECT ${sql.identifier(key)} FROM hits)`:sql``;
  const nameKey=kind==='companies'?sql`regexp_replace(compact_name,${suffixPattern},'')`:sql`compact_name`;
  // Compact names lose word boundaries. "Francisco" can end in a literal
  // "co" or a legal suffix. Retain each plausible company spelling.
  const suffixSpellings=kind==='companies'?sql`UNION ALL
      SELECT id,support_key,digits,search_hit,left(compact_name,n) FROM grouped
      CROSS JOIN LATERAL generate_series(length(name_key),length(compact_name)-1) n
      WHERE peers>1 AND substring(compact_name FROM n+1) ~ ${'^'+suffixPattern}`:sql``;
  // In a shared deletion signature at most one character was removed from each
  // name. Ignoring the two groups containing those characters must give equal
  // strings. Six group combinations cover every pair, regardless of name length.
  return sql`(WITH projected AS (${projection}), blocks AS MATERIALIZED (
      SELECT *, ${nameKey} AS name_key FROM projected
    ), ${hits} supported AS (
      SELECT id,support_key,compact_name,name_key,search_hit,regexp_replace(compact_name,'[^0-9]','','g') AS digits
      FROM blocks WHERE support_key IS NOT NULL ${relevantKey('support_key')}
    ), grouped AS (
      SELECT *,count(*) OVER (PARTITION BY support_key,digits) AS peers FROM supported
    ), spellings AS (
      SELECT id,support_key,digits,search_hit,compact_name AS spelling FROM grouped WHERE peers>1
      ${suffixSpellings}
    ), signatures AS MATERIALIZED (
      SELECT id,support_key,digits,mask_id,search_hit,translate(spelling,mask,'') AS signature
      FROM spellings CROSS JOIN unnest(ARRAY[${sql.join(ignoredPairs.map(mask=>sql`${mask}::text`),sql`, `)}])
        WITH ORDINALITY AS masks(mask,mask_id)
    )
    SELECT id FROM blocks WHERE
      name_key IN (SELECT name_key FROM blocks WHERE name_key IS NOT NULL ${relevantKey('name_key')} GROUP BY name_key HAVING count(*)>1)
      OR identity_key IN (SELECT identity_key FROM blocks WHERE identity_key IS NOT NULL ${relevantKey('identity_key')} GROUP BY identity_key HAVING count(*)>1)
      OR ${uncommon}
    UNION
    SELECT id FROM signatures JOIN (
      SELECT support_key,digits,mask_id,signature FROM signatures GROUP BY support_key,digits,mask_id,signature
      HAVING ${kind==='companies'?sql`count(DISTINCT id)`:sql`count(*)`}>1 ${hasHit}
    ) AS shared USING (support_key,digits,mask_id,signature))`;
}
