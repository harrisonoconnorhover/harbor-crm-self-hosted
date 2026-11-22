import {Column,getTableName,is,sql,type SQLWrapper} from 'drizzle-orm';
import {memberRecordTools,type MemberTool,type MemberToolScope} from '../../lib/portable-tool-permissions';
import {workspaceViewers as members} from './workspace-viewer-schema';

const toolsByTable:Record<string,MemberTool>={contacts:'contacts',companies:'companies',deals:'deals',
  portable_tasks:'tasks',portable_tickets:'tickets',portable_leads:'leads',portable_object_records:'custom-objects'};
export function columnTool(column:SQLWrapper){
  return is(column,Column)?toolsByTable[getTableName(column.table)]:undefined;
}
export function toolLevel(tool:MemberTool|undefined,mode:'view'|'edit'){
  const base=mode==='view'?members.viewScope:members.editScope;
  if(!tool)return sql<MemberToolScope>`${base}`;
  const ceiling=sql`${members.toolPolicies}->${tool}::text->>${mode}::text`;
  return sql<MemberToolScope>`CASE WHEN ${ceiling}='none' THEN 'none'
    WHEN ${base}='owned' OR ${ceiling}='owned' THEN 'owned'
    WHEN ${base}='team' OR ${ceiling}='team' THEN 'team' ELSE 'all' END`;
}
// An owned or team scope includes a record once it is assigned to this editor.
export function canEditAssignedRecord(tool:MemberTool){
  return sql<boolean>`${toolLevel(tool,'edit')}<>'none'`;
}
export function toolWrite(tool:MemberTool,operation:'create'|'edit'|'delete'|'edit-all'){
  const level=toolLevel(tool,operation==='create'?'view':'edit');
  if(operation==='edit-all')return sql`${level}='all'`;
  return sql`(${level}<>'none' AND coalesce((${members.toolPolicies}->${tool}::text->>${operation}::text) ${operation==='edit'?sql`<> 'none'`:sql`= 'true'`},true))`;
}
// A workspace-wide tool whose queries span several objects may only operate when all
// relevant rows can be read. Object-specific tools use toolLevel for each actual row.
const recordKeys=sql.join(memberRecordTools.map(key=>sql`${key}`),sql`,`);
export const allToolViews=sql`(${members.viewScope}='all' AND NOT EXISTS
  (SELECT 1 FROM jsonb_each(${members.toolPolicies}) p WHERE p.key IN (${recordKeys}) AND p.value->>'view'<>'all'))`;
export const allToolWrites=sql`(${members.editScope}='all' AND NOT EXISTS
  (SELECT 1 FROM jsonb_each(${members.toolPolicies}) p WHERE p.key IN (${recordKeys}) AND
    (p.value->>'edit'<>'all' OR p.value->>'create'='false' OR p.value->>'delete'='false')))`;
