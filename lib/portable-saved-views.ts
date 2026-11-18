import {z} from 'zod';
import {portableCustomColumnId,portableRecordListColumns} from './portable-record-list-columns';
import {portableRecordKind,portableRecordRead,portableRecordReadFields,type PortableRecordKind} from './portable-records';

export const portableSavedViewLimit=50;
export const portableSavedViewColumnLimit=50;
export const portableSavedViewId=z.string().guid("Invalid uuid");
export const portableSavedViewFilters=portableRecordReadFields
  .pick({search:true,owner:true,stage:true,pipelineId:true,closeMonth:true,sort:true});
export type PortableSavedViewFilters=z.output<typeof portableSavedViewFilters>;
export type PortableSavedView={
  id:string;
  kind:PortableRecordKind;
  name:string;
  filters:PortableSavedViewFilters;
  columns?:string[];
  shared:boolean;
  revision:number;
  // The workspace editor who created the view; mine marks the reader's own view in a shared workspace.
  author?:string;
  mine?:true;
};

const definition={
  kind:portableRecordKind,
  name:z.string().trim().min(1).max(80),
  filters:portableSavedViewFilters,
  columns:z.array(z.string().min(1).max(80)).min(1).max(portableSavedViewColumnLimit).nullable().optional(),
};
const change={
  id:portableSavedViewId,
  kind:portableRecordKind,
  expectedRevision:z.number().int().min(1).max(2_147_483_647),
};
export const portableSavedViewWrite=z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),...definition}).strict(),
  z.object({action:z.literal('update'),...definition,...change}).strict(),
  z.object({action:z.literal('delete'),...change}).strict(),
  z.object({action:z.literal('setSharing'),...change,shared:z.boolean()}).strict(),
]).refine(input=>{
  if(input.action!=='create'&&input.action!=='update')return true;
  if(!portableRecordRead.safeParse({kind:input.kind,...input.filters}).success)return false;
  const {columns,kind}=input;
  if(!columns)return true;
  const allowed=portableRecordListColumns(kind);
  return columns[0]==='name'&&new Set(columns).size===columns.length&&columns.every(id=>{
    const customId=portableCustomColumnId(id);
    return customId===undefined?allowed.some(column=>column.id===id):
      customId===customId.toLowerCase()&&portableSavedViewId.safeParse(customId).success;
  });
});
export type PortableSavedViewWrite=z.output<typeof portableSavedViewWrite>;

export function portableSavedViewPath(kind:PortableRecordKind,id?:string,after?:string,workspaceId?:string){
  const query=new URLSearchParams();
  if(kind!=='contacts')query.set('kind',kind);
  if(id)query.set('savedView',id);
  if(after)query.set('after',after);
  if(workspaceId)query.set('workspaceId',workspaceId);
  return query.size?'/?'+query:'/';
}
