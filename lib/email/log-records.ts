import {z} from 'zod';
import {utcDateTime} from '../iso-date-time';
import {kinds} from '../crm';
export const emailLogRecord=z.object({id:z.string().min(1).max(150),kind:z.enum(kinds),createdAt:utcDateTime,name:z.string().max(500)}).strict();
export const emailLogRecords=z.array(emailLogRecord).max(100).refine(rows=>new Set(rows.map(r=>r.id)).size===rows.length,'Select each record only once.');
export type EmailLogRecord=z.infer<typeof emailLogRecord>;
export type EmailLogRecordPage={results:EmailLogRecord[];next:string|null};
