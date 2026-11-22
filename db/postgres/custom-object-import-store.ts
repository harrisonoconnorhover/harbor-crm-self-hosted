import {and,eq,inArray} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {z} from 'zod';
import {ApiError} from '../../lib/api-error';
import {parseCSV} from '../../lib/csv-import';
import {exportCsvCell} from '../../lib/shared-record-export';
import {propertyText} from '../../lib/workspace';
import {sha256} from '../../lib/email/crypto';
import {objectValues,type ObjectDefinition,type ObjectField} from '../../lib/portable-custom-objects';
import {objectImportBytes,objectImportLimit,type ObjectCsvRow,type ObjectImportRequest} from '../../lib/portable-object-import';
import {contactImportReceipts as receipts} from './contact-import-schema';
import {objectRecords,objectTypes} from './custom-object-schema';
import {persistCustomRecord} from './custom-object-store';
import {lockPortableLoginSession,type PostgresSessionActor} from './identity-store';
import {recordCustomAccess} from './record-access-store';
import {lockRecordWorkspace} from './private-workspace-store';

function readSheet(csv:string,definition:ObjectDefinition){
  try{
    if(csv.includes('\0'))throw Error('Remove null characters from the spreadsheet.');
    const {headers,rows,historyColumns}=parseCSV(csv,{maxRows:objectImportLimit,maxBytes:objectImportBytes});
    if(historyColumns?.length)throw Error('Use current values instead of property history columns.');
    const fields=new Map(definition.fields.map(field=>[field.label.toLowerCase(),field]));
    const columns=headers.map(header=>{
      const label=header.toLowerCase();
      if(['record id','name','archived at','record owner'].includes(label))return label;
      const field=fields.get(label.replace(/^property:\s*/, ''));
      if(!field)throw Error('Unknown column “'+header+'”. Use a property label from this object.');
      return field;
    });
    const keys=columns.map(c=>typeof c==='string'?c:c.id);
    if(new Set(keys).size!==keys.length)throw Error('Map each column only once.');
    if(!keys.includes('name')&&!keys.includes('record id'))throw Error('Include Name for new rows or Record ID for updates.');
    return {columns,keys,rows};
  }catch(err){throw new ApiError(400,err instanceof Error?err.message:'Invalid CSV.');}
}

function typedCell(field:ObjectField,value:string){
  const trimmed=value.trim();
  if(field.type==='number'){
    if(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed))return Number(trimmed);
    throw Error('Enter a number for '+field.label+'.');
  }
  if(field.type==='multiselect'&&!trimmed.split(';').some(choice=>choice.trim()))throw Error('Choose a value for '+field.label+' or leave the cell blank.');
  if(field.type==='checkbox'){
    if(/^(yes|true|1)$/i.test(trimmed))return true;
    if(/^(no|false|0)$/i.test(trimmed))return false;
    throw Error('Enter Yes or No for '+field.label+'.');
  }
  return field.type==='text'||field.type==='textarea'?value:trimmed;
}

// An exported text cell can carry a leading apostrophe for spreadsheet safety.
function matchesExport(cell:string,value:unknown){
  return value!==undefined&&exportCsvCell(propertyText(value),typeof value==='number')==='"'+cell.replaceAll('"','""')+'"';
}

export async function importObjectRecords(db:PostgresJsDatabase,actor:PostgresSessionActor,input:ObjectImportRequest){
  return db.transaction(async tx=>{
    if(!await lockPortableLoginSession(tx,actor))throw new ApiError(403,'Sign in again.');
    const workspace=await lockRecordWorkspace(tx,actor.userId,false,undefined,undefined,true);
    if(!workspace)throw new ApiError(404,'Object unavailable.');
    const sourceHash=await sha256(JSON.stringify(['custom-object-csv-v1',workspace,input.objectId,input.csv]));
    const apply=input.action==='apply_csv';
    const requestHash=apply?await sha256(sourceHash+input.review):'';
    if(apply){
      const [prior]=await tx.select().from(receipts).where(and(eq(receipts.workspaceId,workspace),eq(receipts.requestId,input.requestId)));
      if(prior){
        if(prior.requestHash!==requestHash)throw new ApiError(409,'This request ID was used for another import.');
        return prior.result;
      }
    }
    const [type]=await tx.select().from(objectTypes).where(and(eq(objectTypes.workspaceId,workspace),eq(objectTypes.id,input.objectId)));
    if(!type)throw new ApiError(404,'Object unavailable.');
    const {keys,columns,rows}=readSheet(input.csv,type.definition);
    const ids=rows.map(row=>row[keys.indexOf('record id')]?.trim().toLowerCase()||'');
    const validIds=ids.filter(id=>z.string().guid().safeParse(id).success);
    const existing=validIds.length?await tx.select().from(objectRecords).where(and(eq(objectRecords.workspaceId,workspace),
      eq(objectRecords.objectId,type.id),inArray(objectRecords.id,validIds))):[];
    const byId=new Map(existing.filter(record=>!record.archivedAt).map(record=>[record.id,record]));
    const plan=rows.map((row,index)=>{
      const id=ids[index],record=byId.get(id);
      const nameCell=row[keys.indexOf('name')]??'';
      const name=record&&matchesExport(nameCell,record.name)?record.name:nameCell.trim()||record?.name||'';
      const summary:ObjectCsvRow={row:index+2,name,state:'skip',changes:[]};
      try{
        if(id&&ids.indexOf(id)!==index)throw Error('Record ID appears more than once.');
        if((id&&!record)||row[keys.indexOf('archived at')]?.trim())throw Error('Use an active record ID from this object.');
        if(!name||name.length>100)throw Error('Enter a name of 1 to 100 characters.');
        const patch=Object.fromEntries(columns.flatMap((field,i)=>typeof field==='object'&&row[i].trim()&&!matchesExport(row[i],record?.data.values[field.id])?
          [[field.id,typedCell(field,row[i])]]:[]));
        const values=objectValues(type.definition,patch,record?.data.values);
        if(record?.name!==name)summary.changes.push({label:'Name',before:record?.name??null,after:name});
        for(const field of type.definition.fields){
          const before=record?.data.values[field.id]??null,after=values[field.id];
          if(after!==undefined&&JSON.stringify(before)!==JSON.stringify(after))summary.changes.push({label:field.label,before,after});
        }
        summary.state=!record?'create':summary.changes.length?'update':'skip';
        return {summary,id,revision:record?.revision??0,values};
      }catch(error){
        summary.state='error';
        summary.error=error instanceof Error?error.message:'Check this row.';
        return {summary,id,revision:record?.revision??0,values:{}};
      }
    });
    const review=await sha256(JSON.stringify([sourceHash,type.revision,plan.map(p=>p.revision)]));
    if(!apply){
      await recordCustomAccess(tx,actor,'list',Array.from(byId.keys(),id=>({objectId:type.id,id})),workspace);
      return {review,rows:plan.map(p=>p.summary)};
    }
    if(review!==input.review)throw new ApiError(409,'The spreadsheet or records changed. Preview again.');
    if(plan.some(p=>p.summary.state==='error'))throw new ApiError(400,'Fix all errors and preview again.');
    const result={created:0,updated:0,skipped:0};
    for(const {summary,id,revision,values} of plan){
      if(summary.state==='skip'){result.skipped++;continue;}
      const recordOwner=byId.get(id)?.data.recordOwner;
      await persistCustomRecord(tx,actor.userId,type,{workspaceId:workspace,objectId:type.id,id:id||crypto.randomUUID(),
        name:summary.name,revision:revision+1,data:{values,recordOwner}},recordOwner?.userId);
      if(id)result.updated++;else result.created++;
    }
    await tx.insert(receipts).values({workspaceId:workspace,requestId:input.requestId,requestHash,result,createdAt:new Date().toISOString()});
    return result;
  });
}
