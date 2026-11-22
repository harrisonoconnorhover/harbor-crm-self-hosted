import {z} from 'zod';
import {DirectoryError} from '../db/postgres/workspace-directory-store';

export const scimHeaders={'content-type':'application/scim+json','cache-control':'private, no-store'};
export const scimMessage='urn:ietf:params:scim:api:messages:2.0:';

// Entra can declare an extension without sending extension attributes.
export function scimInputSchemas(core:string,extension:string){
  return z.array(z.enum([core,extension])).min(1).max(2)
    .refine(ids=>ids.includes(core)&&new Set(ids).size===ids.length);
}

export function scimListResponse(total:number,start:number,resources:unknown[]){
  return Response.json({schemas:[scimMessage+'ListResponse'],totalResults:total,startIndex:start,
    itemsPerPage:resources.length,Resources:resources},{headers:scimHeaders});
}

// POST searches use arrays for field selection. Both transports feed the same list parser.
const searchFields=z.array(z.string().min(1).refine(field=>!field.includes(','))).min(1);
const searchRequest=z.object({
  schemas:z.tuple([z.literal(scimMessage+'SearchRequest')]),filter:z.string().optional(),
  startIndex:z.number().int().optional(),count:z.number().int().optional(),
  attributes:searchFields.optional(),excludedAttributes:searchFields.optional(),
}).strict();
export function scimSearchParams(body:unknown){
  const fields=searchRequest.parse(body);
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(fields)){
    if(key!=='schemas'&&value!==undefined)params.set(key,Array.isArray(value)?value.join(','):String(value));
  }
  return params;
}

// A directory can qualify a core attribute with its schema URN. Preserve everything
// after the prefix, including case-sensitive filter literals and external IDs.
export function scimCorePath(value:string,type:'User'|'Group'){
  const prefix='urn:ietf:params:scim:schemas:core:2.0:'+type.toLowerCase()+':';
  return value.slice(0,prefix.length).toLowerCase()===prefix?value.slice(prefix.length):value;
}

// Tokenize exact comparisons as a whole so "and" inside a quoted identifier stays literal.
export function* scimEqualities(expression:string,type:'User'|'Group'){
  const input=expression.trim();
  const clause=/([\w.:-]+)\s+eq\s+(true|false|"(?:[^"\\]|\\.)*")(?:(\s+and\s+)|$)/iy;
  for(;;){
    const match=clause.exec(input);
    if(!match)throw new DirectoryError(400,'Use exact directory filters joined by and.','invalidFilter');
    let value:string|boolean;
    try{value=match[2].startsWith('"')?JSON.parse(match[2]):match[2].toLowerCase()==='true';}
    catch{throw new DirectoryError(400,'Invalid quoted filter value.','invalidFilter');}
    yield {field:scimCorePath(match[1],type).toLowerCase(),value};
    if(!match[3])return;
  }
}

// Parse the response selection before performing any requested membership change.
export function scimSelection(params:URLSearchParams,type:'User'|'Group'){
  const include=params.getAll('attributes'),exclude=params.getAll('excludedAttributes');
  if(include.length+exclude.length>1)throw new DirectoryError(400,'Use one attributes or excludedAttributes parameter.','invalidValue');
  const value=include[0]??exclude[0];
  const paths=new Set(value?.toLowerCase().split(',').map(raw=>{
    const path=raw.trim();
    if(!/^(?:urn:[a-z0-9:._-]+:)?(?:[a-z][a-z0-9_-]*|\$ref)(?:\.(?:[a-z][a-z0-9_-]*|\$ref))?$/.test(path))
      throw new DirectoryError(400,'Choose comma-separated directory attributes.','invalidValue');
    return scimCorePath(path,type);
  }));
  function selected(field:string){
    if(value===undefined)return true;
    const matches=paths.has(field)||paths.has(field.split('.')[0]);
    return include.length?matches:!matches;
  }
  function wanted(field:string){
    const children=complexFields.get(field);
    return children?children.some(name=>selected(field+'.'+name)):selected(field);
  }
  function project(row:Record<string,unknown>){
    if(value===undefined)return row;
    const result:Record<string,unknown>={schemas:row.schemas,id:row.id};
    for(const [key,value] of Object.entries(row)){
      const field=key.toLowerCase();
      if(field==='schemas'||field==='id'||!wanted(field))continue;
      const children=(child:object)=>Object.fromEntries(Object.entries(child).filter(([name])=>wanted(field+'.'+name.toLowerCase())));
      if(Array.isArray(value))result[key]=value.map(children);
      else result[key]=value&&typeof value==='object'?children(value):value;
    }
    return result;
  }
  return {wanted,project};
}

// Only complex attributes have selectable children. A path such as userName.value
// must never return the scalar userName as though its parent had been requested.
const complexFields=new Map<string,string[]>([
  ['meta',['resourcetype','location']],['roles',['value']],
  ['groups',['value','display','type','$ref']],['members',['value','type','$ref']],
]);
