import {z} from 'zod';
export const teamName=z.string().trim().min(1).max(80);
export const teamNameKey=(name:string)=>name.normalize('NFKC').trim().toLowerCase();
export const MAX_EXTRA_TEAMS=20;
const workspaceId=z.string().guid("Invalid uuid"),id=z.string().guid("Invalid uuid"),revision=z.number().int().positive();
export const workspaceTeamQuery=z.discriminatedUnion('action',[
 z.object({action:z.literal('list'),workspaceId,after:z.string().max(3000).default(''),query:z.string().trim().max(100).default('')}).strict(),
 z.object({action:z.literal('members'),workspaceId,id,after:z.string().max(200).default(''),query:z.string().trim().max(100).default(''),assigned:z.enum(['yes','no']).default('yes')}).strict(),
]);
export const workspaceTeamMutation=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),workspaceId,name:teamName}).strict(),
 z.object({action:z.literal('parent'),workspaceId,id,revision,parentId:id.nullable(),parentRevision:revision.nullable()}).strict(),
 z.object({action:z.literal('rename'),workspaceId,id,revision,name:teamName}).strict(),
 z.object({action:z.literal('delete'),workspaceId,id,revision}).strict(),
 z.object({action:z.literal('assign'),workspaceId,memberId:z.string().min(1).max(200),memberRevision:revision,assignmentRevision:z.number().int().nonnegative(),teamId:id.nullable(),teamRevision:revision.nullable()}).strict(),
 z.object({action:z.literal('extra'),workspaceId,memberId:z.string().min(1).max(200),memberRevision:revision,assignmentRevision:revision,teamId:id,teamRevision:revision,add:z.boolean()}).strict(),
]);
export type TeamQuery=z.infer<typeof workspaceTeamQuery>;
export type TeamMutation=z.infer<typeof workspaceTeamMutation>;
export type WorkspaceTeam={id:string;name:string;revision:number;members:number;extraMembers:number;retainedMembers:number;retainedExtraMembers:number;parentId:string|null;parentName:string|null;children:number};
export type WorkspaceTeamPage={items:WorkspaceTeam[];next:string|null;canEdit:boolean};
export type TeamMemberRow={id:string;name:string;email:string;status:string;memberRevision:number;assignmentRevision:number;teamId:string|null;teamName:string|null;extra:boolean;extraCount:number};
export type TeamMemberPage={team:WorkspaceTeam;items:TeamMemberRow[];next:string|null;canEdit:boolean};

export const encodeTeamCursor=(nameKey:string,id:string)=>JSON.stringify([nameKey,id]);
export function decodeTeamCursor(value:string):[string,string]{return value?z.tuple([z.string().max(2000),z.string().guid("Invalid uuid")]).parse(JSON.parse(value)):['',''];}
