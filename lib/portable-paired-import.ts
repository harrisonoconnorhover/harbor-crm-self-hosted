import {ApiError} from './api-error';
import {MAX_IMPORT_ROWS,parseCSV} from './csv-import';
import {autoMapPaired,coalesceObject,type PairedKind} from './paired-import';
import {portableCsvBytes,portableImportFields,preparePortableRecordCsv} from './portable-contact-import';

export function portablePairedFields(){
  return (['contacts','companies'] as const).flatMap(kind=>portableImportFields(kind)
    .filter(([field])=>field!=='primaryCompanyId')
    .map(([field,label])=>[kind+'/'+field,(kind==='contacts'?'Contact · ':'Company · ')+label] as const));
}

export function mapPortablePairedCsv(text:string,requested?:string[]){
  try{
    const {headers,rows,historyColumns}=parseCSV(text,{maxRows:MAX_IMPORT_ROWS,maxBytes:portableCsvBytes});
    if(historyColumns?.length)throw Error('History export columns cannot be used in a create-only import.');
    const fields=new Map(portablePairedFields());
    const mapping=requested??autoMapPaired(headers,[]).map(field=>fields.has(field)?field:'');
    if(mapping.length!==headers.length)throw Error('Choose a mapping for each CSV column.');
    const targets=mapping.filter(Boolean);
    if(targets.some(field=>!fields.has(field)))throw Error('A mapped property is unavailable for this import.');
    if(new Set(targets).size!==targets.length)throw Error('Map each property only once.');
    return {headers,rows,mapping,fields};
  }catch(error){throw new ApiError(400,error instanceof Error?error.message:'Check the CSV.');}
}

export function preparePortablePairedCsv(source:ReturnType<typeof mapPortablePairedCsv>){
  try{
    if(!source.mapping.includes('contacts/email')||!source.mapping.includes('companies/domain')){
      throw Error('Map Contact · Email and Company · Domain for a combined import.');
    }
    const input={...source,matchProperties:{},modes:{contacts:'create',companies:'create'} as const};
    const group=(kind:PairedKind)=>coalesceObject(input,kind,[],[]);
    const contacts=group('contacts'),companies=group('companies');
    const prepare=(kind:PairedKind,groups:typeof contacts)=>preparePortableRecordCsv(kind,{
      ...groups,headers:groups.mapping,fields:new Map(portableImportFields(kind)),properties:[],remapped:false,
    });
    const contactRows=prepare('contacts',contacts),companyRows=prepare('companies',companies);
    if(contactRows.kind!=='contacts'||companyRows.kind!=='companies')throw Error('Check both record mappings.');
    const links=new Map<number,number>();
    for(const [line,contact] of contacts.bySource){
      const company=companies.bySource.get(line);
      if(company===undefined)continue;
      const previous=links.get(contact);
      if(previous!==undefined&&previous!==company)throw Error('CSV row '+line+': choose one primary company per contact.');
      links.set(contact,company);
    }
    return {contactRows,companyRows,contacts,companies,links};
  }catch(error){
    if(error instanceof ApiError)throw error;
    throw new ApiError(400,error instanceof Error?error.message:'Check the combined CSV.');
  }
}
