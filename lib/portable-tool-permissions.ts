import {z} from 'zod';
import {portableToolNames} from './portable-nav-tools';
import type {RecordScope,WorkspaceRole} from './portable-workspace-access';

export const memberRecordTools=['contacts','companies','deals','leads','tasks','tickets','custom-objects'] as const;
export const auxiliaryTools=['segments','team-inbox','knowledge','snippets','reports','dashboards','forecast','goals','meetings','files','recycle-bin','calls','duplicates','sales-workspace'] as const;
export type AuxiliaryTool=typeof auxiliaryTools[number];
export const memberTools=[...memberRecordTools,...auxiliaryTools] as const;
export const isAuxiliaryTool=(tool:MemberTool):tool is AuxiliaryTool=>auxiliaryTools.some(key=>key===tool);
export const editableAuxiliaryTool=(tool:MemberTool)=>['team-inbox','meetings','files','duplicates','recycle-bin'].includes(tool);
export type MemberTool=typeof memberTools[number];
export const memberToolNames:Record<MemberTool,string>=portableToolNames;
export const memberToolScopes=['none','owned','team','all'] as const;
const scope=z.enum(memberToolScopes);
export type MemberToolScope=z.infer<typeof scope>;
export const memberToolPolicy=z.object({view:scope,create:z.boolean(),edit:scope,delete:z.boolean()}).strict()
  .refine(policy=>memberToolScopes.indexOf(policy.edit)<=memberToolScopes.indexOf(policy.view)&&
    (!policy.create||policy.view!=='none')&&(!policy.delete||policy.edit!=='none'),
    {message:'Editing must fit within viewing access. Creating needs view access and deleting needs edit access.'});
export type MemberToolPolicy=z.infer<typeof memberToolPolicy>;
export type ToolPolicies=Partial<Record<MemberTool,MemberToolPolicy>>;
export const toolPermissionChange=z.object({action:z.literal('tool_permissions'),ids:z.array(z.string().guid().toLowerCase()).min(1).max(150)
  .refine(ids=>new Set(ids).size===ids.length),tool:z.enum(memberTools),policy:memberToolPolicy}).strict().refine(({tool,policy})=>!isAuxiliaryTool(tool)||
  ((tool==='files'||!policy.create)&&!policy.delete&&['none','all'].includes(policy.view)&&
    (policy.edit==='none'||(editableAuxiliaryTool(tool)&&policy.edit==='all'))),
  {message:'Choose an available action for this workspace tool.'});
const narrow=(a:MemberToolScope,b:MemberToolScope)=>memberToolScopes[Math.min(memberToolScopes.indexOf(a),memberToolScopes.indexOf(b))];
export function effectiveMemberToolPolicy(member:{role:WorkspaceRole;viewScope:RecordScope;editScope:RecordScope;toolPolicies?:ToolPolicies},tool:MemberTool):MemberToolPolicy{
  const policy=member.toolPolicies?.[tool];
  if(isAuxiliaryTool(tool)){
    const view=policy?.view==='none'?'none':'all';
    const edit=editableAuxiliaryTool(tool)&&member.role==='editor'&&view==='all'&&policy?.edit!=='none'?'all':'none';
    return {view,edit,create:tool==='files'&&member.role==='editor'&&view==='all'&&(policy?.create??true),delete:false};
  }
  const view=narrow(member.viewScope,policy?.view??'all');
  const edit=member.role==='editor'?narrow(view,narrow(member.editScope,policy?.edit??'all')):'none';
  return {view,edit,create:member.role==='editor'&&view!=='none'&&(policy?.create??true),delete:edit!=='none'&&(policy?.delete??true)};
}
