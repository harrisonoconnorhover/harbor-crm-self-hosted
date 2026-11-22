import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {evaluatePortableReport,readPortableReports} from '../db/postgres/portable-report-store';
import {portableReportHasFilters,portableReportMetricLabel,portableReportExportGroupLimit,portableReportFilename,portableReportGroupHeading,
  type PortableReportDefinition,type PortableReportExport,type PortableReportResult} from '../lib/portable-reports';
import {exportCsvCell} from '../lib/shared-record-export';

const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};

function reportCsv(definition:PortableReportDefinition,result:PortableReportResult){
  const includeCount=definition.metric!=='count';
  const heading=portableReportGroupHeading(definition);
  const columns=[heading,portableReportMetricLabel(definition.metric),...(includeCount?[definition.metric==='rate'?'Assessed tickets':definition.metric==='average'?'Answered tickets':'Records']:[])];
  const data=(label:string,value:string|null,count:string)=>[exportCsvCell(label),exportCsvCell(value,true),
    ...(includeCount?[exportCsvCell(count,true)]:[])].join(',');
  return [columns.map(column=>exportCsvCell(column)).join(','),
    ...result.rows.map(row=>data(row.label,row.value,row.count)),
    data(portableReportHasFilters(definition)?'Matching records':'All records',result.total,result.count)].join('\r\n')+'\r\n';
}

async function evaluateSavedExport(db:PostgresJsDatabase,actorId:string,input:Extract<PortableReportExport,{id:string}>){
  return db.transaction(async tx=>{
    const item=await readPortableReports(tx,actorId,{id:input.id});
    if(!item||'items' in item)return {error:404 as const};
    if(item.revision!==input.revision)return {error:409 as const};
    const definition=item.definition;
    return {definition,result:await evaluatePortableReport(tx,actorId,definition,portableReportExportGroupLimit)};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

export async function portableReportCsvResponse(db:PostgresJsDatabase,actorId:string,input:PortableReportExport){
  const evaluated='definition' in input
    ?{definition:input.definition,result:await evaluatePortableReport(db,actorId,input.definition,portableReportExportGroupLimit)}
    :await evaluateSavedExport(db,actorId,input);
  const error=(status:number,message:string)=>Response.json({error:message},{status,headers});
  if('error' in evaluated&&evaluated.error)return evaluated.error===404?error(404,'Report not found.'):
    error(409,'This report changed. Reload it before exporting.');
  const {definition,result}=evaluated;
  if(result.truncated)return error(413,`This report has more than ${portableReportExportGroupLimit} groups. Choose a report with fewer groups to export the full result.`);
  return new Response(reportCsv(definition,result),{headers:{...headers,'content-type':'text/csv; charset=utf-8',
    'content-disposition':`attachment; filename="${portableReportFilename(definition.name)}"`,
  }});
}
