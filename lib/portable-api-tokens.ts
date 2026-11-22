import {z} from 'zod';
import {COMPANY_DOMAIN_MAX} from './crm';
import {emailAddress} from './email/message';
import {tokenInput,tokenScopes} from './api-access';
import {portableCompanyFields,portableContactFields,portableDealFields,portableRecordKind,portableRecordReadFields} from './portable-records';
import {portableLeadFields} from './portable-leads';
import {portableTaskFields} from './portable-tasks';
import {portableTicketFields} from './portable-tickets';

const id=z.string().guid("Invalid uuid");
export const portableExternalRecordKind=z.enum([...portableRecordKind.options,'tasks','leads','tickets']);
export type PortableExternalRecordKind=z.output<typeof portableExternalRecordKind>;
const accessLevel=z.enum(['read','read_history','read_write','read_write_history','read_write_archive']);
const duration=z.union([z.literal(30),z.literal(90),z.literal(365)]);
const common={name:z.string().trim().min(1).max(80),days:duration};
const crmTokenCreate=tokenInput.refine(input=>input.objects[0]==='inquiries'||input.objects.every(object=>portableExternalRecordKind.safeParse(object).success),
  'Choose supported record permissions, or a separate inquiry token.');
const recordPermissions=z.partialRecord(portableExternalRecordKind,accessLevel)
  .refine(permissions=>Object.keys(permissions).length>0,'Choose access for at least one record type.');
export const portableApiPrimaryLinks=z.object({companyId:id.toLowerCase().nullable().optional(),contactId:id.toLowerCase().nullable().optional()})
  .strict().refine(links=>Object.keys(links).length>0,'Choose a primary link.');
export type PortableApiPrimaryLinks=z.infer<typeof portableApiPrimaryLinks>;
export function canManagePrimaryLinks(permissions:Partial<Record<PortableExternalRecordKind,string>>){
  return portableRecordKind.options.filter(kind=>permissions[kind]?.startsWith('read_write')).length>=2;
}
export const portableTokenCreate=z.union([
  z.object({...common,permissions:recordPermissions,associationAccess:z.enum(['read','read_write','primary','all']).optional()}).strict()
    .refine(input=>!input.associationAccess||portableRecordKind.options.some(kind=>input.permissions[kind]&&(input.associationAccess==='read'||input.permissions[kind]?.startsWith('read_write'))),'Choose matching record access for at least one relationship type.')
    .refine(input=>!['primary','all'].includes(input.associationAccess??'')||canManagePrimaryLinks(input.permissions),'Choose edit access for both record types.'),
  crmTokenCreate,
  z.object({...common,purpose:z.enum(['directory','saml_directory','oidc_directory'])}).strict(),
]);

export function entraDirectoryScope(tenant:string){
  return 'directory:entra:'+z.guid().parse(tenant).toLowerCase();
}

export function portableTokenScopes(input:z.output<typeof portableTokenCreate>,directoryScope?:string){
  if('purpose' in input&&input.purpose==='oidc_directory'){
    if(!directoryScope||!/^directory:oidc:[0-9a-f]{64}$/.test(directoryScope))throw Error('Configure an OpenID Connect directory before creating its token.');
    return [directoryScope];
  }
  if('purpose' in input&&input.purpose==='saml_directory'){
    if(!directoryScope||!/^directory:saml:[0-9a-f]{64}$/.test(directoryScope))throw Error('Configure a SAML directory before creating its token.');
    return [directoryScope];
  }
  if('purpose' in input){
    if(!directoryScope?.startsWith('directory:entra:'))throw Error('Configure a Microsoft directory before creating its token.');
    return [directoryScope];
  }
  if('permissions' in input)return portableExternalRecordKind.options.flatMap(kind=>{
    const level=input.permissions[kind];
    if(level==='read_history'||level==='read_write_history'){
      return [...tokenScopes([kind],level==='read_history'?'read':'read_write'),kind+':archive_history'];
    }
    return level?tokenScopes([kind],level):[];
  }).concat(input.associationAccess?['associations:read']:[],
    input.associationAccess==='read_write'||input.associationAccess==='all'?['associations:write']:[],
    input.associationAccess==='primary'||input.associationAccess==='all'?['associations:primary']:[]);
  return tokenScopes(input.objects,input.permission);
}
export const portableTokenRevoke=z.object({action:z.literal('revoke'),id}).strict();
export const portableTokenPage=z.object({
  afterAt:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  afterId:id.optional(),
}).strict().refine(input=>(input.afterAt===undefined)===(input.afterId===undefined));
export const portableExternalRecordPage=portableRecordReadFields.pick({limit:true}).extend({after:id.optional()}).strict();
// Match the millisecond precision returned in the change-window cursor.
const windowInstant=z.iso.datetime().refine(value=>!value.startsWith('0000')&&!/\.\d{4}/.test(value))
  .transform(value=>new Date(value).toISOString());
type RecordWindowBounds={since:string;before:string;after?:string;afterAt?:string};
function validRecordWindow(p:RecordWindowBounds){
  return p.since<p.before&&Boolean(p.after)===Boolean(p.afterAt)&&(!p.afterAt||(p.afterAt>=p.since&&p.afterAt<p.before));
}
export const portableUpdatedRecordPage=portableExternalRecordPage.extend({
  updatedSince:windowInstant,updatedBefore:windowInstant,afterUpdatedAt:windowInstant.optional(),
}).transform(({updatedSince:since,updatedBefore:before,afterUpdatedAt:afterAt,...page})=>({...page,since,before,afterAt})).refine(validRecordWindow);
export const portableArchivedRecordPage=portableExternalRecordPage.extend({
  archivedSince:windowInstant,archivedBefore:windowInstant,afterArchivedAt:windowInstant.optional(),
}).transform(({archivedSince:since,archivedBefore:before,afterArchivedAt:afterAt,...page})=>({...page,since,before,afterAt})).refine(validRecordWindow);
export const portableDeletedRecordPage=portableExternalRecordPage.extend({
  deletedSince:windowInstant,deletedBefore:windowInstant,afterDeletedAt:windowInstant.optional(),
}).transform(({deletedSince:since,deletedBefore:before,afterDeletedAt:afterAt,...page})=>({...page,since,before,afterAt})).refine(validRecordWindow);
export type PortableRecordWindow=z.output<typeof portableUpdatedRecordPage>;
export const portableResponseProperties=z.array(z.string().min(1).max(150)).max(100).optional();
const batchIds=(key:z.ZodType<string>)=>z.array(z.object({id:key}).strict()).min(1).max(50);
export const portableAssociationBatch=z.object({
  inputs:z.array(z.object({id:id.toLowerCase(),after:id.toLowerCase().optional()}).strict()).min(1).max(50)
    .refine(items=>new Set(items.map(item=>item.id)).size===items.length,'Use distinct source IDs.'),
  limit:z.number().int().min(1).max(50).default(25),
}).strict();
const customIdentifierProperty=z.templateLiteral(['custom:',z.string().guid()]).transform(value=>value.toLowerCase() as `custom:${string}`);
const externalTextId=z.string().min(1).max(2000).refine(value=>value.trim().length>0&&!value.includes('\0'));
export const portableExternalRecordBatch=z.union([
  z.object({idProperty:z.undefined().optional(),inputs:batchIds(id),properties:portableResponseProperties}).strict(),
  z.object({idProperty:z.literal('email'),inputs:batchIds(emailAddress),properties:portableResponseProperties}).strict(),
  z.object({idProperty:z.literal('domain'),inputs:batchIds(z.string().trim().min(1).max(COMPANY_DOMAIN_MAX).refine(value=>!value.includes('\0')&&!/\s/.test(value))),properties:portableResponseProperties}).strict(),
  z.object({idProperty:customIdentifierProperty,inputs:batchIds(externalTextId),properties:portableResponseProperties}).strict(),
]).refine(({inputs,idProperty})=>new Set(inputs.map(item=>idProperty?.startsWith('custom:')?item.id:item.id.toLowerCase())).size===inputs.length);

export const portableExternalStandardFields={
  contacts:portableContactFields.shape,
  companies:portableCompanyFields.shape,
  deals:portableDealFields.shape,
  tasks:portableTaskFields.shape,
  leads:portableLeadFields.shape,
  tickets:portableTicketFields.omit({owner:true}).shape,
} satisfies Record<PortableExternalRecordKind,z.ZodRawShape>;

export function validPortableBatchProperties(kind:PortableExternalRecordKind,properties?:string[]){
  const supportsCustom=kind==='contacts'||kind==='companies'||kind==='deals';
  return properties===undefined||properties.every(field=>Object.hasOwn(portableExternalStandardFields[kind],field)||
    supportsCustom&&(field==='custom'||field.startsWith('custom:')&&id.safeParse(field.slice(7)).success));
}
