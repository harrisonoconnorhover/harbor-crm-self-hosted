import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {customExportBatch} from '../db/postgres/custom-object-store';
import type {PostgresSessionActor} from '../db/postgres/identity-store';
import type {ObjectExport} from '../lib/portable-custom-objects';
import {exportCsvCell} from '../lib/shared-record-export';
import {propertyText} from '../lib/workspace';

export async function customObjectCsv(db:PostgresJsDatabase,actor:PostgresSessionActor,q:ObjectExport,request:Request){
  const head=request.method==='HEAD';
  const first=await customExportBatch(db,actor,q,head);
  const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff',
    'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="harbor-object-${q.objectId}.csv"`};
  if(head)return new Response(null,{headers});
  const encoder=new TextEncoder();
  const header=['Record ID','Name','Record owner','Archived at',...first.fields.map(f=>'Property: '+f.label)].map(c=>exportCsvCell(c)).join(',');
  let initial=true,cursor=first.next;
  const body=new ReadableStream<Uint8Array>({
    async pull(controller){
      request.signal.throwIfAborted();
      const page=initial?first:await customExportBatch(db,actor,q,false,cursor);
      const lines=initial?[header]:[];
      for(const row of page.rows){
        lines.push([... [row.id,row.name,row.data.recordOwner?.label,row.archivedAt].map(value=>exportCsvCell(value)),
          ...page.fields.map(field=>exportCsvCell(propertyText(row.data.values[field.id]),field.type==='number'))].join(','));
      }
      if(lines.length)controller.enqueue(encoder.encode(lines.join('\r\n')+'\r\n'));
      initial=false;cursor=page.next;
      if(!cursor)controller.close();
    },
  },{highWaterMark:0});
  return new Response(body,{headers});
}
