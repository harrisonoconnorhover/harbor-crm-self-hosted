import {sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import type {PortableRecordKind} from '../../lib/portable-records';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {deals} from './deal-schema';
import {portableAssociations as links} from './portable-association-schema';

const tables={contacts,companies,deals};

function primaryColumn(from:PortableRecordKind,to:PortableRecordKind){
  if(from==='contacts'&&to==='companies')return contacts.primaryCompanyId;
  if(from==='deals'&&to==='contacts')return deals.primaryContactId;
  if(from==='deals'&&to==='companies')return deals.companyId;
}

type LinkRow={id:string;linkId:string|null;explicit:boolean;labels:string[];primary:boolean;reversePrimary:boolean};
type PageRow={sourceId:string}&(LinkRow|{[K in keyof LinkRow]:null});
type SourceInput={id:string;after?:string};

export async function readExternalAssociationPages(db:PostgresJsDatabase,workspace:string,kind:PortableRecordKind,
  targetKind:PortableRecordKind,inputs:SourceInput[],limit:number,targetId?:string){
  const source=tables[kind],target=tables[targetKind];
  const primary=primaryColumn(kind,targetKind),reverse=primaryColumn(targetKind,kind);
  const rows=await db.execute<PageRow>(sql`
    WITH sources AS (
      SELECT ${source.id} AS id, i.after, ${primary??sql`NULL::uuid`} AS primary_id
      FROM jsonb_to_recordset(${JSON.stringify(inputs)}::jsonb) AS i(id uuid, after uuid)
      JOIN ${source} ON ${source.workspaceId}=${workspace} AND ${source.id}=i.id AND ${source.archivedAt} IS NULL
    )
    SELECT s.id AS "sourceId", page.* FROM sources s LEFT JOIN LATERAL (
      WITH explicit_links AS NOT MATERIALIZED (
        SELECT second_id AS id, id AS link_id, labels FROM ${links}
          WHERE workspace_id=${workspace} AND first_kind=${kind} AND first_id=s.id AND second_kind=${targetKind}
        UNION ALL
        SELECT first_id AS id, id AS link_id, labels FROM ${links}
          WHERE workspace_id=${workspace} AND second_kind=${kind} AND second_id=s.id AND first_kind=${targetKind}
      ), candidates AS (
        SELECT id FROM explicit_links
        UNION SELECT s.primary_id
        ${reverse?sql`UNION SELECT ${target.id} FROM ${target} WHERE ${target.workspaceId}=${workspace}
          AND ${reverse}=s.id AND ${target.archivedAt} IS NULL`:sql``}
      )
      SELECT c.id, l.link_id AS "linkId", l.id IS NOT NULL AS explicit, coalesce(l.labels,'[]'::jsonb) AS labels,
        coalesce(c.id=s.primary_id,false) AS "primary",
        ${reverse?sql`coalesce(${reverse}=s.id,false)`:sql`false`} AS "reversePrimary"
      FROM candidates c JOIN ${target} ON ${target.workspaceId}=${workspace} AND ${target.id}=c.id AND ${target.archivedAt} IS NULL
      LEFT JOIN explicit_links l ON l.id=c.id
      WHERE ${targetId?sql`c.id=${targetId}::uuid`:sql`s.after IS NULL OR c.id>s.after`}
      ORDER BY c.id LIMIT ${limit+1}
    ) page ON true ORDER BY s.id,page.id`);
  const groups=new Map<string,(LinkRow&{object:PortableRecordKind})[]>();
  for(const {sourceId,...row} of rows){
    let results=groups.get(sourceId);
    if(!results){results=[];groups.set(sourceId,results);}
    // A left-join placeholder distinguishes an active, unlinked source from a missing one.
    if(row.id)results.push({...row,object:targetKind});
  }
  return inputs.map(({id})=>{
    const group=groups.get(id);
    if(!group)return null;
    return {results:group.slice(0,limit),next:group.length>limit?{after:group[limit-1].id}:null};
  });
}

export async function readExternalAssociations(db:PostgresJsDatabase,workspace:string,kind:PortableRecordKind,id:string,
  targetKind:PortableRecordKind,{limit,after}:{limit:number;after?:string},targetId?:string){
  const [page]=await readExternalAssociationPages(db,workspace,kind,targetKind,[{id,after}],limit,targetId);
  return page;
}
