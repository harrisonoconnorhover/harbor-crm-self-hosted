import {entraDirectoryScope} from '../lib/portable-api-tokens';
import {z} from 'zod';
import {currentPortableApiToken} from '../db/postgres/portable-api-token-store';
import {createDirectoryUser,deleteDirectoryUser,directoryPage,directoryUser,DirectoryError,lockDirectory,setDirectoryAccess,setDirectoryDisplayName,type DirectoryScope} from '../db/postgres/workspace-directory-store';
import {digest} from '../lib/api-access';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {directoryDiscovery,discoveryPath} from './portable-directory-schemas';
import {directoryGroups} from './portable-directory-groups';
import {scimHeaders as headers,scimMessage as message,scimListResponse,scimInputSchemas,scimSelection,scimSearchParams,scimCorePath,scimEqualities} from './portable-scim';
import {portableDb} from './portable-db';
import {oidcDirectoryScope,oidcSubjectKey,validOidcSubject} from './portable-company-oidc-config';
import {oidcDirectoryCanBind,portableOidcDirectoryConfig,directoryCanBind,portableDirectoryConfig,portableSamlDirectoryConfig,samlDirectoryCanBind} from './portable-login-config';
import {samlDirectoryScope,samlSubject,validSamlNameId} from './portable-saml-config';
import {portableRateLimit} from './portable-rate-limit';

const core='urn:ietf:params:scim:schemas:core:2.0:User';
const usersPath='/scim/v2/Users',groupsPath='/scim/v2/Groups';
const bool=z.union([z.boolean(),z.enum(['True','False','true','false']).transform(v=>v.toLowerCase()==='true')]);
const roleValue=z.object({value:z.enum(['viewer','editor'])}).strict();
const roles=z.array(roleValue).max(1);
const displayName=z.string().trim().max(254).refine(value=>!value.includes('\0')).nullable().transform(value=>value||null);
const userProfile=z.object({schemas:scimInputSchemas(core,'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'),
  meta:z.object({}).optional(),userName:z.email().max(254).toLowerCase(),
  roles:roles.optional(),displayName:displayName.optional(),locale:z.string().optional(),
  name:z.object({}).optional(),emails:z.array(z.object({})).optional(),groups:z.array(z.object({})).optional()}).strict();
const create=userProfile.extend({externalId:z.string(),active:bool.default(true),password:z.string().optional()});
const put=userProfile.extend({externalId:z.string().optional(),active:bool.optional(),id:z.string().guid().optional()});
const operation=z.object({op:z.string().toLowerCase().pipe(z.enum(['add','replace','remove'])),path:z.string().toLowerCase().optional(),value:z.unknown().optional()}).strict();
const accessPatch=z.object({schemas:z.tuple([z.literal(message+'PatchOp')]),Operations:z.array(operation).min(1).max(3)}).strict();
function accessChanges(body:unknown){
  let active:boolean|undefined,role:'viewer'|'editor'|null|undefined;
  let name:string|null|undefined;
  for(const change of accessPatch.parse(body).Operations){
    if(change.op==='remove'){
      if(!change.path)throw new DirectoryError(400,'Specify the attribute to remove.','noTarget');
      if(change.value!==undefined)throw new DirectoryError(400,'Remove the attribute without a value.','invalidValue');
      const path=scimCorePath(change.path,'User');
      if(path==='roles'&&role===undefined)role=null;
      else if(path==='displayname'&&name===undefined)name=null;
      else throw new DirectoryError(400,'Remove roles or displayName once per request.','invalidPath');
      continue;
    }
    const fields=change.path===undefined?z.record(z.string(),z.unknown()).parse(change.value):{[change.path]:change.value};
    if(!Object.keys(fields).length)throw new DirectoryError(400,'Specify active, roles or displayName.','invalidValue');
    for(const [key,value] of Object.entries(fields)){
      const path=scimCorePath(key,'User').toLowerCase();
      if(path==='displayname'&&name===undefined)name=displayName.parse(value);
      else if(change.op==='replace'&&path==='active'&&active===undefined)active=bool.parse(value);
      else if(change.op==='replace'&&path==='roles'&&role===undefined)role=roles.parse(value)[0]?.value??null;
      else throw new DirectoryError(400,'Unsupported or repeated directory attribute.','invalidPath');
    }
  }
  return {active,role,displayName:name};
}
const errorResponse=(status:number,detail:string,scimType?:string)=>Response.json({
  schemas:[message+'Error'],status:String(status),detail,...(scimType?{scimType}:{})},
  {status,headers:{...headers,...(status===401?{'www-authenticate':'Bearer'}:{})}});
function resource(row:Awaited<ReturnType<typeof directoryUser>>,origin:string){
  return {schemas:[core],id:row.id,externalId:row.externalId,userName:row.email,displayName:row.displayName??undefined,active:row.active,
    groups:row.groupId?[{value:row.groupId,display:row.groupName,type:'direct',$ref:origin+groupsPath+'/'+row.groupId}]:[],
    roles:row.role?[{value:row.role}]:[],meta:{resourceType:'User',location:origin+usersPath+'/'+row.id}};
}
type EmployeeFilter=Parameters<typeof directoryPage>[2];

function employeeFilter(expression:string,protocol:DirectoryScope['protocol']):EmployeeFilter|null{
  const filter:EmployeeFilter={};
  let matches=true;
  for(const {field,value} of scimEqualities(expression,'User')){
    let next:EmployeeFilter|null;
    if(field==='active'&&typeof value==='boolean'){
      next={active:value};
    }else{
      if(typeof value!=='string'||!['id','username','externalid','roles.value','groups.value'].includes(field))
        throw new DirectoryError(400,'Use id, userName, externalId, active, roles.value or groups.value with the appropriate value type.','invalidFilter');
      if(field==='username')next=z.email().max(254).safeParse(value).success?{email:value.toLowerCase()}:null;
      else if(field==='externalid')next=(protocol==='oidc'?validOidcSubject(value):protocol==='saml'?validSamlNameId(value):z.string().guid().safeParse(value).success)
        ?{externalId:protocol?value:value.toLowerCase()}:null;
      else if(field==='id'||field==='groups.value')next=z.string().guid().safeParse(value).success?
        (field==='id'?{id:value.toLowerCase()}:{groupId:value.toLowerCase()}):null;
      else next=value==='viewer'||value==='editor'?{role:value}:null;
    }
    // Users have one active state, role and primary group. Conflicting equalities cannot match.
    if(next){
      for(const [key,value] of Object.entries(next)){
        if(Object.hasOwn(filter,key)&&filter[key as keyof EmployeeFilter]!==value)matches=false;
      }
      Object.assign(filter,next);
    }else matches=false;
  }
  return matches?filter:null;
}

function listQuery(params:URLSearchParams,protocol:DirectoryScope['protocol']){
  const page=z.object({startIndex:z.coerce.number().int().min(1).max(2147483647).default(1),
    count:z.coerce.number().int().min(0).max(2147483647).default(100),filter:z.string().max(8192).optional()}).strict().parse(Object.fromEntries(params));
  if(params.size!==new Set(params.keys()).size)throw new DirectoryError(400,'Duplicate list parameter.');
  const result={start:page.startIndex,size:Math.min(page.count,100)};
  return {...result,filter:page.filter===undefined?{}:employeeFilter(page.filter,protocol)};
}

type Token=NonNullable<Awaited<ReturnType<typeof currentPortableApiToken>>>;
function tokenDirectory(token:Token,entra:ReturnType<typeof portableDirectoryConfig>,saml:ReturnType<typeof portableSamlDirectoryConfig>,oidc:ReturnType<typeof portableOidcDirectoryConfig>){
  const {workspaceId,ownerId}=token;
  if(token.scopes.length!==1)return;
  if(entra&&token.scopes[0]===entraDirectoryScope(entra.tenant)&&entra.allowedEmails.includes(token.email)){
    return {scope:{workspaceId,ownerId,tenant:entra.tenant} satisfies DirectoryScope,
      externalId:z.string().guid().toLowerCase(),binding:(id:string)=>entra.bindings.get(id),canDelegate:(email:string)=>directoryCanBind(entra,workspaceId,email)};
  }
  if(oidc&&token.scopes[0]===oidcDirectoryScope(oidc.issuer)&&oidc.allowedEmails.includes(token.email)){
    return {scope:{workspaceId,ownerId,protocol:'oidc',issuer:oidc.issuer} satisfies DirectoryScope,
      externalId:z.string().refine(validOidcSubject),binding:(id:string)=>oidc.bindings.get(oidcSubjectKey(oidc.issuer,id)),canDelegate:(email:string)=>oidcDirectoryCanBind(oidc,workspaceId,email)};
  }
  if(saml&&token.scopes[0]===samlDirectoryScope(saml.issuer)&&saml.allowedEmails.includes(token.email)){
    return {scope:{workspaceId,ownerId,protocol:'saml',issuer:saml.issuer} satisfies DirectoryScope,
      externalId:z.string().refine(validSamlNameId),binding:(id:string)=>saml.bindings.get(samlSubject(saml.issuer,id)),canDelegate:(email:string)=>samlDirectoryCanBind(saml,workspaceId,email)};
  }
}

export async function portableDirectory(request:Request){
  try{
    const entra=portableDirectoryConfig(),saml=portableSamlDirectoryConfig(),oidc=portableOidcDirectoryConfig();
    if(!entra&&!saml&&!oidc)return errorResponse(404,'Directory provisioning is unavailable.');
    const credential=/^Bearer (harbor_[a-f0-9]{64})$/i.exec(request.headers.get('authorization')??'');
    if(!credential)return errorResponse(401,'A directory token is required.');
    const db=portableDb(),token=await currentPortableApiToken(db,await digest(credential[1]));
    if(!token)return errorResponse(401,'Invalid or expired directory token.');
    const directory=tokenDirectory(token,entra,saml,oidc);
    if(!directory)return errorResponse(403,'A workspace directory token is required.');
    const url=new URL(request.url);
    const search=url.pathname===usersPath+'/.search'||url.pathname===groupsPath+'/.search';
    const readSearch=search&&request.method==='POST';
    const method=readSearch?'GET':request.method;
    const limited=await portableRateLimit(method==='GET'?'api_read':'api_write',token.id);
    if(limited)return limited;
    const {scope}=directory;

    if(discoveryPath(url.pathname)){
      if(method!=='GET')return errorResponse(405,'Directory discovery is read-only.');
      return await db.transaction(async tx=>{
        await lockDirectory(tx,scope,token.id);
        return directoryDiscovery(url,scope.protocol);
      });
    }
    const groups=url.pathname===groupsPath||url.pathname.startsWith(groupsPath+'/');
    const users=url.pathname===usersPath||url.pathname.startsWith(usersPath+'/');
    if(!users&&!groups)return errorResponse(404,'Directory resource not found.');
    if(search&&!readSearch)return errorResponse(405,'Use POST for a directory search.');
    if(search&&url.search)return errorResponse(400,'Send search parameters in the request body.');
    const id=search?'':url.pathname.slice((groups?groupsPath:usersPath).length+1);
    if(id&&!z.string().guid().safeParse(id).success)return errorResponse(404,groups?'Group not found.':'Employee not found.');
    const isList=method==='GET'&&!id;
    if(method==='DELETE'&&url.search)return errorResponse(400,'Unexpected query parameters.');
    if(!(id?['GET','PUT','PATCH','DELETE']:['GET','POST']).includes(method))return errorResponse(405,'Unsupported directory operation.');
    let body:unknown;
    if(readSearch||method==='POST'||method==='PATCH'||method==='PUT'){
      const limit=groups?65536:16384;
      const text=await readBoundedRequestText(request,limit);
      if(text===null)return errorResponse(413,'Request exceeds '+limit/1024+' KiB.');
      body=JSON.parse(text);
    }
    const params=readSearch?scimSearchParams(body):url.searchParams;
    const selection=scimSelection(params,groups?'Group':'User');
    params.delete('attributes');
    params.delete('excludedAttributes');
    if(!isList&&params.size)return errorResponse(400,'Unexpected query parameters.');
    const page=isList&&!groups?listQuery(params,scope.protocol):undefined;
    return await db.transaction(async tx=>{
      await lockDirectory(tx,scope,token.id);
      if(groups)return directoryGroups(tx,scope,url.origin,params,id,method,body,selection);
      if(page){
        if(!page.filter)return scimListResponse(0,page.start,[]);
        const result=await directoryPage(tx,scope,page.filter,page.start,page.size);
        return scimListResponse(result.total,page.start,result.rows.map(row=>selection.project(resource(row,url.origin))));
      }
      const verifyBinding=(externalId:string,email:string)=>{
        const pinned=directory.binding(externalId);
        if(pinned===email)return null;
        if(pinned===undefined&&directory.canDelegate(email))return scope.workspaceId;
        throw new DirectoryError(400,'Employee must match a configured directory identity and address.','invalidValue');
      };
      if(method==='POST'){
        const input=create.parse(body),externalId=directory.externalId.parse(input.externalId),role=input.roles?.[0]?.value;
        const directoryAuthority=verifyBinding(externalId,input.userName);
        if(!input.active&&role)throw new DirectoryError(400,'Assign a role when activating the employee.','invalidValue');
        const row=resource(await createDirectoryUser(tx,scope,{userName:input.userName,active:input.active,externalId,role,displayName:input.displayName,directoryAuthority}),url.origin);
        return Response.json(selection.project(row),{status:201,headers:{...headers,location:row.meta.location}});
      }
      const row=await directoryUser(tx,scope,id);
      if(method==='DELETE'){
        await deleteDirectoryUser(tx,scope,id,row.userId);
        return new Response(null,{status:204,headers});
      }
      if(method==='PATCH'||method==='PUT'){
        let change:ReturnType<typeof accessChanges>;
        if(method==='PUT'){
          const input=put.parse(body);
          if((input.id!==undefined&&input.id!==id)||input.userName!==row.email||
            (input.externalId!==undefined&&directory.externalId.parse(input.externalId)!==row.externalId))
            throw new DirectoryError(400,'The employee identity and address are immutable.','mutability');
          // A directory may send an ordinary profile refresh without mapping membership fields.
          const active=input.active??row.active;
          const role=active&&input.roles!==undefined?(input.roles[0]?.value??null):undefined;
          change={active,role,displayName:input.displayName};
        }else change=accessChanges(body);
        const active=change.active??row.active;
        if(!active&&change.role)throw new DirectoryError(400,'Assign a role when activating the employee.','invalidValue');
        if(active)verifyBinding(row.externalId,row.email);
        // An explicit clear uses the active seat’s default role. An omitted role preserves its grant.
        const role=change.role===null?'viewer':change.role;
        await setDirectoryAccess(tx,scope,row.userId,active,role);
        if(change.displayName!==undefined&&change.displayName!==row.displayName)
          await setDirectoryDisplayName(tx,scope,id,change.displayName);
        return Response.json(selection.project(resource(await directoryUser(tx,scope,id),url.origin)),{headers});
      }
      return Response.json(selection.project(resource(row,url.origin)),{headers});
    });
  }catch(error){
    if(error instanceof DirectoryError)return errorResponse(error.status,error.message,error.scimType);
    if(error instanceof z.ZodError||error instanceof SyntaxError)return errorResponse(400,'Unsupported or invalid directory attributes.','invalidValue');
    return errorResponse(503,'Directory unavailable. Try again.');
  }
}
