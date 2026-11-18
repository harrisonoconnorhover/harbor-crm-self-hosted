import {z} from 'zod';
import {utcDateTime} from './iso-date-time';
export const fileHistoryActions={uploaded:'Uploaded',added:'Added to library',renamed:'Renamed',replaced:'Contents replaced',moved:'Moved',archived:'Archived',unarchived:'Unarchived',trashed:'Moved to trash',restored:'Restored from trash',removed:'Removed from library'} as const;
export const historyFilters=z.object({action:z.enum(['all',...Object.keys(fileHistoryActions) as [keyof typeof fileHistoryActions,...(keyof typeof fileHistoryActions)[]]]).default('all'),actor:z.string().max(200).default(''),from:utcDateTime.optional(),to:utcDateTime.optional()}).strict().refine(q=>!q.from||!q.to||q.from<=q.to,'Start date must be before end date.');
export type FileHistoryFilters=z.infer<typeof historyFilters>;
export type FileHistoryEntry={id:string;action:keyof typeof fileHistoryActions;actor:string;createdAt:string;beforeValue:string;afterValue:string};
