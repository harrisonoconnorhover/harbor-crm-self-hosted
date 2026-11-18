import {z} from 'zod';
import {ticketSlaFieldIds} from './ticket-sla-properties';
export const listSorts=['name','email','domain','owner','status','amount','closeDate','createdAt','updatedAt','lastContacted','lastActivity',...ticketSlaFieldIds] as const;
export type CustomRecordColumn=`custom:${string}`;
export const isCustomRecordColumn=(id:string):id is CustomRecordColumn=>/^custom:[a-zA-Z0-9_-]{1,100}$/.test(id);
export const sharedListSort=z.union([z.enum(listSorts),z.custom<CustomRecordColumn>(v=>typeof v==='string'&&isCustomRecordColumn(v),'Choose an available sort property.')]);
export type SharedListSort=z.infer<typeof sharedListSort>;
