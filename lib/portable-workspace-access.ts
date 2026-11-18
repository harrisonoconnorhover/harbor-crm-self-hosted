import {z} from 'zod';
export const workspaceSeatLimit=25;

export const workspaceRole=z.enum(['viewer','editor']);
export type WorkspaceRole=z.infer<typeof workspaceRole>;
export type WorkspacePermission='contactFiles'|'scheduledNotes'|'contactOutreach'|'recordActivities';
export const sharedRecordWriteScope=z.object({workspaceId:z.string().guid("Invalid uuid"),grantId:z.string().guid("Invalid uuid")}).strict();
export type SharedRecordWriteScope=z.infer<typeof sharedRecordWriteScope>;

export const workspaceInvitationId=z.string().guid("Invalid uuid").transform(value=>value.toLowerCase());
export const workspaceInvitationPath=(id:string)=>'/?invitation='+encodeURIComponent(id);
