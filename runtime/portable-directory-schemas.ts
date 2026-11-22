import {DirectoryError} from '../db/postgres/workspace-directory-store';
import {scimHeaders,scimListResponse} from './portable-scim';

const schemasPath='/scim/v2/Schemas';
const typesPath='/scim/v2/ResourceTypes';
const configPath='/scim/v2/ServiceProviderConfig';
export const discoveryPath=(path:string)=>path===configPath||[schemasPath,typesPath].some(base=>path===base||path.startsWith(base+'/'));
const corePrefix='urn:ietf:params:scim:schemas:core:2.0:';
const schemaId=corePrefix+'Schema';

const attribute={type:'string',multiValued:false,required:false,caseExact:false,mutability:'readWrite',returned:'default',uniqueness:'none'};
function definitions(protocol:'saml'|'oidc'|undefined){
  const common=[
    {...attribute,name:'id',description:'Harbor resource ID.',required:true,caseExact:true,mutability:'readOnly',returned:'always',uniqueness:'server'},
    {...attribute,name:'externalId',description:protocol==='oidc'?'Case-sensitive OpenID Connect subject (sub).':protocol?'Case-sensitive persistent SAML NameID.':'Microsoft Entra object ID in the configured directory.',caseExact:!!protocol,required:true,mutability:'immutable',uniqueness:'server'},
  ];

  const user={name:'User',description:'A workspace employee provisioned by the directory.',attributes:[...common,
      {...attribute,name:'userName',description:'The employee’s sign-in email address.',required:true,mutability:'immutable',uniqueness:'server'},
      {...attribute,name:'displayName',description:'Employee name shown in this workspace’s directory.'},
      {name:'active',type:'boolean',description:'Whether the employee has workspace access.',multiValued:false,required:false,mutability:'readWrite',returned:'default'},
      {...attribute,name:'groups',type:'complex',description:'Groups managed by this directory for the employee.',multiValued:true,mutability:'readOnly',
        subAttributes:[
          {...attribute,name:'value',description:'Harbor directory Group ID.',mutability:'readOnly'},
          {...attribute,name:'display',description:'Directory group name.',mutability:'readOnly'},
          {...attribute,name:'type',canonicalValues:['direct'],mutability:'readOnly'},
          {...attribute,name:'$ref',type:'reference',referenceTypes:['Group'],mutability:'readOnly'},
        ]},
      {name:'roles',type:'complex',description:'The employee’s single workspace role.',multiValued:true,required:false,mutability:'readWrite',returned:'default',
        subAttributes:[{...attribute,name:'value',required:true,caseExact:true,canonicalValues:['viewer','editor']}]},
    ]};
  const groupIdentity=protocol?[common[0],{...common[1],required:false,description:'Optional case-sensitive directory group identifier.'}]:common;
  const group={name:'Group',description:'A directory group linked to a workspace team by its owner.',attributes:[...groupIdentity,
      {...attribute,name:'displayName',description:'Directory group name.',required:true,uniqueness:'server'},
      {name:'members',type:'complex',description:'Active directory Users assigned to this group.',multiValued:true,required:false,mutability:'readWrite',returned:'default',
        subAttributes:[
          {...attribute,name:'value',description:'Harbor directory User ID.',required:true,mutability:'immutable'},
          {name:'$ref',type:'reference',referenceTypes:['User'],multiValued:false,required:false,mutability:'readOnly',returned:'default'},
          {...attribute,name:'type',canonicalValues:['User'],mutability:'immutable'},
        ]},
    ]};
  return [user,group];
}

export function directoryDiscovery(url:URL,protocol:'saml'|'oidc'|undefined){
  // RFC 7644 section 4 requires complete discovery lists, independent of pagination.
  if(url.searchParams.has('filter'))throw new DirectoryError(403,'Directory discovery does not support filtering.');
  if(url.pathname===configPath){
    return Response.json({schemas:[corePrefix+'ServiceProviderConfig'],patch:{supported:true},filter:{supported:true,maxResults:100},
      bulk:{supported:false,maxOperations:0,maxPayloadSize:0},changePassword:{supported:false},sort:{supported:false},etag:{supported:false},
      authenticationSchemes:[{type:'oauthbearertoken',name:'Bearer token',description:'Workspace directory bearer token.',primary:true}],
      meta:{resourceType:'ServiceProviderConfig',location:url.origin+configPath}},{headers:scimHeaders});
  }
  const types=url.pathname===typesPath||url.pathname.startsWith(typesPath+'/'),base=types?typesPath:schemasPath;
  const resources=definitions(protocol).map(definition=>{
    const schema=corePrefix+definition.name,id=types?definition.name:schema;
    const meta={resourceType:types?'ResourceType':'Schema',location:url.origin+base+'/'+id};
    if(types)return {schemas:[corePrefix+'ResourceType'],id,name:definition.name,description:definition.description,
      endpoint:'/'+definition.name+'s',schema,meta};
    return {...definition,schemas:[schemaId],id,meta};
  });
  if(url.pathname===base)return scimListResponse(resources.length,1,resources);
  let id:string;
  try{id=decodeURIComponent(url.pathname.slice(base.length+1));}
  catch{throw new DirectoryError(404,'Directory definition not found.');}
  const resource=resources.find(row=>row.id===id);
  if(!resource)throw new DirectoryError(404,'Directory definition not found.');
  return Response.json(resource,{headers:scimHeaders});
}
