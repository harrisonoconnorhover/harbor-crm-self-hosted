import {z} from 'zod';
import {teamName} from './workspace-teams';

const id=z.string().uuid().toLowerCase();
const position={name:teamName,parentId:id.nullable()};
const version={id,revision:z.number().int().positive()};
export const teamChanges=[
  z.object({action:z.literal('team_create'),id,...position}).strict(),
  z.object({action:z.literal('team_edit'),...version,...position}).strict(),
  z.object({action:z.literal('team_remove'),...version}).strict(),
  z.object({action:z.literal('team_assign'),id,teamId:id.nullable(),previousTeamId:id.nullable()}).strict(),
] as const;
export const directoryGroupChange=z.object({action:z.enum(['directory_group_map','directory_group_unmap']),
  teamId:id,externalId:z.string().trim().guid().toLowerCase()}).strict();
export const directoryOpaqueId=z.string().min(1).max(254).refine(value=>!value.includes('\0'));
export const samlGroupChange=z.object({action:z.enum(['saml_group_map','saml_group_unmap','oidc_group_map','oidc_group_unmap']),teamId:id,
  expectedExternalId:directoryOpaqueId.optional(),groupName:z.string().trim().min(1).max(120).refine(name=>!name.includes('\0'))}).strict();
export type DirectoryGroupMapping={teamId:string;groupId:string|null;displayName:string|null}&({externalId:string}|{groupName:string;directoryId?:string|null});
export type DirectoryGroupChange=z.infer<typeof directoryGroupChange>|z.infer<typeof samlGroupChange>;
export type TeamChange=z.infer<(typeof teamChanges)[number]>;
export type DirectoryTeam={id:string;name:string;parentId:string|null;revision:number};
export const directoryTeamLimit=100;

// The directory is bounded, and each team has one parent.
export function teamAncestors<T extends DirectoryTeam>(teams:T[],start:string|null){
  const byId=new Map(teams.map(team=>[team.id,team]));
  const path:T[]=[];
  const seen=new Set<string>();
  let current=start&&byId.get(start);
  while(current&&!seen.has(current.id)){
    path.unshift(current);
    seen.add(current.id);
    current=current.parentId&&byId.get(current.parentId);
  }
  return path;
}
