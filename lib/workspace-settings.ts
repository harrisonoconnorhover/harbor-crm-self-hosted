import {z} from 'zod';
export const timeZoneSchema=z.string().trim().min(1).max(100).refine(value=>{
 try {new Intl.DateTimeFormat('en-US',{timeZone:value});return true;}catch{return false;}
},'Choose a valid time zone, such as America/New_York.').transform(value=>new Intl.DateTimeFormat('en-US',{timeZone:value}).resolvedOptions().timeZone);
export const workspaceSettingsSchema=z.object({timeZone:timeZoneSchema,fiscalYearStartMonth:z.number().int().min(1).max(12).optional(),revision:z.number().int().min(0)});
export type WorkspaceSettingsInput=z.infer<typeof workspaceSettingsSchema>;
export type WorkspaceSettings=WorkspaceSettingsInput&{fiscalYearStartMonth:number};
export const defaultWorkspaceSettings:WorkspaceSettings={timeZone:'UTC',fiscalYearStartMonth:1,revision:0};
