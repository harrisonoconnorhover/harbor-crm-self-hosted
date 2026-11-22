import {recordAccess,recordPrimaryLinks} from '../db/postgres/record-access-store';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {listPortableSavedViews} from '../db/postgres/saved-view-store';
import {listPortableCustomProperties} from '../db/postgres/custom-property-store';
import type {PortableCustomProperty} from '../lib/portable-custom-properties';
import {portableCustomColumnId,portableLastContactedColumn,portableRecordListColumns,portableRecordListValue} from '../lib/portable-record-list-columns';
import {portableSavedViewId} from '../lib/portable-saved-views';
import {readPortableLastContacted} from '../db/postgres/portable-external-record-store';
import {portableRecordReaders} from '../db/postgres/portable-record-readers';
import {portableRecordRead,type CompanyRecord,type ContactRecord,type DealRecord,type PortableRecordKind} from '../lib/portable-records';
import {exportCsvCell} from '../lib/shared-record-export';
import {standardFields} from '../lib/standard-properties';

const exportLimit=500;
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const columns={
  contacts:[['name','Name'],['email','Email'],['phone','Phone'],['title','Job title'],['lifecycle','Lifecycle stage'],
    ['primaryCompanyId','Primary company ID'],['primaryCompanyName','Primary company']],
  companies:[['name','Name'],['domain','Domain'],['website','Website'],['industry','Industry'],['city','City'],['lifecycle','Lifecycle stage']],
  deals:[['name','Name'],['amount','Amount'],['closeDate','Close date'],['pipelineId','Pipeline ID'],['pipelineName','Pipeline'],
    ['stageId','Stage ID'],['stageName','Stage'],['companyId','Company ID'],['companyName','Company'],
    ['primaryContactId','Primary contact ID'],['primaryContactName','Primary contact']],
} as const;

function recordCsv(kind:PortableRecordKind,records:(ContactRecord|CompanyRecord|DealRecord)[],selected?:string[],custom:PortableCustomProperty[]=[],lastContactedById?:Record<string,string|null>){
  const available=new Map(portableRecordListColumns(kind,custom).map(column=>[column.id,column.label]));
  const display=selected?selected.flatMap(id=>available.has(id)?[[id,available.get(id)!]]:[]):
    [...columns[kind],...standardFields(kind).map(field=>[field.id,field.label]),['createdAt','Create date'],['updatedAt','Last modified date']];
  const fields=[['id','Record ID'],...display];
  const line=(values:unknown[])=>values.map(value=>exportCsvCell(value)).join(',');
  const rows=records.map(record=>{
    const values:Record<string,unknown>={...record.data,...record,lastContacted:lastContactedById?.[record.id]};
    return line(fields.map(([key])=>portableRecordListValue(record,values,key)));
  });
  return {text:[line(fields.map(([,label])=>label)),...rows].join('\r\n')+'\r\n',columns:fields.map(([id])=>id)};
}

export async function portableRecordCsv(db:PostgresJsDatabase,user:{userId:string;guest:boolean;email:string},query:Record<string,string>,head:boolean){
  const {export:format,savedView,...filters}=query;
  const error=(status:number,message:string)=>Response.json({error:message},{status,headers});
  if(user.guest||filters.workspaceId!==undefined)return error(403,'Export records from your own workspace.');
  if(format!=='csv'||filters.id!==undefined||filters.after!==undefined||filters.limit!==undefined)
    return error(400,'Choose a record type and list filters to export.');
  const input=portableRecordRead.safeParse(filters);
  if(!input.success)return error(400,'Invalid record export filters.');

  const {kind}=input.data;
  let view;
  if(savedView!==undefined){
    if(!portableSavedViewId.safeParse(savedView).success||Object.keys(filters).some(key=>key!=='kind'))
      return error(400,'Choose one saved view without other filters.');
    view=(await listPortableSavedViews(db,user.userId,kind)).find(candidate=>candidate.id===savedView);
    if(!view)return error(404,'Saved view not found.');
  }
  // The same bounded query serves the list and respects the owner scope.
  const page=await portableRecordReaders[kind](db,user.userId,{...input.data,...view?.filters,limit:exportLimit});
  if(!page||!('records' in page))return error(400,'Choose a record list to export.');
  if(page.next)return error(413,`This list matches more than ${exportLimit} records. Narrow your filters to export the full list.`);
  const custom=!head&&view?.columns?.some(column=>portableCustomColumnId(column)!==undefined)
    ?await listPortableCustomProperties(db,user.userId,kind):[];
  const lastContactedById=!head&&kind==='contacts'&&view?.columns?.includes(portableLastContactedColumn.id)
    ?await readPortableLastContacted(db,user.userId,page.records.map(row=>row.id)):undefined;
  const csv=head?null:recordCsv(kind,page.records,view?.columns,custom,lastContactedById);
  if(csv){
    await recordAccess(db,user,kind,'csv',page.records.map(row=>row.id));
    await recordPrimaryLinks(db,user,page.records,undefined,csv.columns);
  }
  return new Response(csv?.text??null,{headers:{...headers,
    'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="harbor-${kind}.csv"`,
  }});
}
