import {z} from 'zod';

export const scopeLabels={owned:'Their own records',team:'Their team and child teams',all:'All workspace records'};
export const recordScopes=['owned','team','all'] as const;
export const recordScope=z.enum(recordScopes);
export type RecordScope=z.infer<typeof recordScope>;
export type MemberRecordAccess={viewScope:RecordScope;editScope:RecordScope};
export const fullRecordAccess:MemberRecordAccess={viewScope:'all',editScope:'all'};
export const validRecordAccess=(access:MemberRecordAccess)=>recordScopes.indexOf(access.editScope)<=recordScopes.indexOf(access.viewScope);
export const workspaceRole=z.enum(['viewer','editor']);
export type WorkspaceRole=z.infer<typeof workspaceRole>;
export type WorkspacePermission='contactFiles'|'scheduledNotes'|'contactOutreach'|'recordActivities';
export const sharedRecordWriteScope=z.object({workspaceId:z.string().guid("Invalid uuid"),grantId:z.string().guid("Invalid uuid")}).strict();
export type SharedRecordWriteScope=z.infer<typeof sharedRecordWriteScope>;

export const workspaceInvitationId=z.string().guid("Invalid uuid").transform(value=>value.toLowerCase());
export const workspaceInvitationPath=(id:string)=>'/?invitation='+encodeURIComponent(id);
