import {directoryOpaqueId as opaqueId} from '../lib/portable-workspace-teams';
import {z} from 'zod';
import {createDirectoryGroup,deleteDirectoryGroup,directoryGroup,directoryGroupPage,patchDirectoryGroup,type DirectoryGroupChange} from '../db/postgres/workspace-directory-group-store';
import {DirectoryError} from '../db/postgres/workspace-directory-store';
import {scimCorePath,scimEqualities,scimHeaders,scimInputSchemas,scimListResponse,scimMessage,type scimSelection} from './portable-scim';

const core='urn:ietf:params:scim:schemas:core:2.0:Group';
const id=z.string().guid().toLowerCase();
const displayName=z.string().trim().min(1).max(120).refine(name=>!name.includes('\0'));
const member=z.object({value:id,type:z.literal('User').optional(),display:z.string().optional(),
  $ref:z.string().nullable().optional()}).strict().transform(item=>item.value);
const members=z.array(member);
const create=z.object({schemas:scimInputSchemas(core,'http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group'),
  meta:z.object({}).optional(),externalId:id,displayName,members:members.optional()}).strict();
const namedGroupCreate=create.extend({externalId:opaqueId.optional()});
const replace=create.extend({id:id.optional(),externalId:id.optional()});
const namedGroupReplace=replace.extend({externalId:opaqueId.optional()});
const operation=z.object({op:z.string().toLowerCase().pipe(z.enum(['add','replace','remove'])),
  path:z.string().trim().transform(value=>scimCorePath(value,'Group').toLowerCase()).optional(),value:z.unknown().optional()}).strict();
const patch=z.object({schemas:z.tuple([z.literal(scimMessage+'PatchOp')]),Operations:z.array(operation).min(1).max(100)}).strict();

function groupChanges(body:unknown,groupId:string):DirectoryGroupChange[]{
  const changes:DirectoryGroupChange[]=[];
  for(const {op,path,value} of patch.parse(body).Operations){
    if(path===undefined&&op!=='remove'){
      const fields:Record<string,unknown>=Object.create(null);
      for(const [key,field] of Object.entries(z.record(z.string(),z.unknown()).parse(value))){
        const attribute=scimCorePath(key,'Group').toLowerCase();
        if(Object.hasOwn(fields,attribute))throw new DirectoryError(400,'Repeated group attribute.','invalidPath');
        fields[attribute]=field;
      }
      const input=z.object({id:id.optional(),displayname:displayName.optional(),members:members.optional()}).strict().parse(fields);
      if(input.id!==undefined&&input.id!==groupId.toLowerCase())
        throw new DirectoryError(400,'The directory group identity is immutable.','mutability');
      if(input.displayname===undefined&&input.members===undefined)throw new DirectoryError(400,'Specify displayName or members.','invalidValue');
      if(input.displayname!==undefined)changes.push({op:'rename',displayName:input.displayname});
      if(input.members!==undefined)changes.push({op,members:input.members});
    }else if(path==='displayname'&&op!=='remove'){
      changes.push({op:'rename',displayName:displayName.parse(value)});
    }else if(path==='members'){
      if(op==='remove'&&value===undefined)changes.push({op:'replace',members:[]});
      else changes.push({op,members:members.parse(value)});
    }else{
      const filter=path&&/^members\[\s*value\s+eq\s+"([^"\\]+)"\s*\]$/.exec(path);
      if(op==='remove'&&filter&&value===undefined)changes.push({op:'remove',members:[id.parse(filter[1])]});
      else throw new DirectoryError(400,'Unsupported group attribute or operation.',path?'invalidPath':'noTarget');
    }
  }
  return changes;
}

const list=z.object({startIndex:z.coerce.number().int().min(1).max(2147483647).default(1),
  count:z.coerce.number().int().min(0).max(2147483647).default(100),filter:z.string().max(500).optional()}).strict();
function groupFilter(expression:string|undefined,namedDirectory:boolean){
  const filters:Parameters<typeof directoryGroupPage>[2]=[];
  if(expression===undefined)return filters;
  let possible=true;
  for(const {field,value} of scimEqualities(expression,'Group')){
    if(typeof value!=='string'||!['id','displayname','externalid','members.value'].includes(field))
      throw new DirectoryError(400,'Use a quoted id, displayName, externalId or members.value.','invalidFilter');
    if(field==='displayname'){
      if(value.length>0&&value.length<=120&&!value.includes('\0'))filters.push({displayName:value});
      else possible=false;
    }else{
      const parsed=(field==='externalid'&&namedDirectory?opaqueId:id).safeParse(value);
      if(!parsed.success)possible=false;
      else if(field==='externalid')filters.push({externalId:parsed.data});
      else if(field==='id')filters.push({id:parsed.data});
      else filters.push({memberId:parsed.data});
    }
  }
  return possible?filters:null;
}

function resource(row:Awaited<ReturnType<typeof directoryGroup>>,origin:string){
  return {schemas:[core],id:row.id,externalId:row.externalId??undefined,displayName:row.displayName,
    members:row.members.map(value=>({value,$ref:origin+'/scim/v2/Users/'+value,type:'User'})),
    meta:{resourceType:'Group',location:origin+'/scim/v2/Groups/'+row.id}};
}

export async function directoryGroups(tx:Parameters<typeof directoryGroup>[0],scope:Parameters<typeof directoryGroup>[1],
  origin:string,params:URLSearchParams,groupId:string,method:string,body:unknown,selection:ReturnType<typeof scimSelection>){
  const namedDirectory=scope.issuer!==undefined;
  const includeMembers=selection.wanted('members');
  if(method==='GET'){
    if(params.size!==new Set(params.keys()).size)throw new DirectoryError(400,'Duplicate group query parameter.');
    const query=Object.fromEntries(params);
    if(groupId){
      const row=await directoryGroup(tx,scope,groupId,includeMembers);
      return Response.json(selection.project(resource(row,origin)),{headers:scimHeaders});
    }
    const page=list.parse(query),filter=groupFilter(page.filter,namedDirectory);
    if(filter===null)return scimListResponse(0,page.startIndex,[]);
    const result=await directoryGroupPage(tx,scope,filter,page.startIndex,Math.min(page.count,100),includeMembers);
    return scimListResponse(result.total,page.startIndex,result.rows.map(row=>selection.project(resource(row,origin))));
  }
  if(method==='POST'){
    const row=resource(await createDirectoryGroup(tx,scope,(namedDirectory?namedGroupCreate:create).parse(body),includeMembers),origin);
    return Response.json(selection.project(row),{status:201,headers:{...scimHeaders,location:row.meta.location}});
  }
  if(method==='PUT'){
    const current=await directoryGroup(tx,scope,groupId,false);
    const input=(namedDirectory?namedGroupReplace:replace).parse(body);
    if((input.id!==undefined&&input.id!==current.id)||(input.externalId!==undefined&&input.externalId!==current.externalId))
      throw new DirectoryError(400,'The directory group identity is immutable.','mutability');
    const changes:DirectoryGroupChange[]=[{op:'rename',displayName:input.displayName}];
    // A group read without members can be sent back for a name-only update.
    if(input.members!==undefined)changes.push({op:'replace',members:input.members});
    const row=await patchDirectoryGroup(tx,scope,groupId,changes,includeMembers);
    return Response.json(selection.project(resource(row,origin)),{headers:scimHeaders});
  }
  if(method==='PATCH'){
    const row=await patchDirectoryGroup(tx,scope,groupId,groupChanges(body,groupId),includeMembers);
    return Response.json(selection.project(resource(row,origin)),{headers:scimHeaders});
  }
  await deleteDirectoryGroup(tx,scope,groupId);
  return new Response(null,{status:204,headers:scimHeaders});
}
