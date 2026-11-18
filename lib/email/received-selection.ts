import {z} from 'zod';
import {MAX_ATTACHMENT_BYTES} from '../activity-attachments';
import {MAX_EMAIL_ATTACHMENTS,MAX_EMAIL_ATTACHMENT_BYTES} from './attachments';
import type {ReceivedFileSource} from './received-files';

export const receivedFileSelection=z.array(z.object({part:z.string().regex(/^0(?:\.\d+){0,25}$/).max(150),name:z.string().min(1).max(200),size:z.number().int().positive().max(MAX_ATTACHMENT_BYTES)}).strict()).max(MAX_EMAIL_ATTACHMENTS).refine(files=>new Set(files.map(f=>f.part)).size===files.length,'Choose each received file only once.').refine(files=>files.reduce((n,f)=>n+f.size,0)<=MAX_EMAIL_ATTACHMENT_BYTES,'Choose at most 20 MB of received files.');
export type ReceivedFileSelection=z.infer<typeof receivedFileSelection>;
export const selectionKey=(selection?:ReceivedFileSelection)=>selection===undefined?'all':JSON.stringify([...selection].sort((a,b)=>a.part.localeCompare(b.part)).map(({part,name,size})=>({part,name,size})));
export function selectReceivedFiles(files:ReceivedFileSource[],selection?:ReceivedFileSelection){
 if(selection===undefined)return files;receivedFileSelection.parse(selection);
 for(const chosen of selection){const file=files.find(f=>f.part===chosen.part);if(!file||file.name!==chosen.name||file.size!==chosen.size||!file.downloadable)throw Error('A selected received file changed or is unavailable. Refresh the file list and choose again.');}
 return files.filter(f=>selection.some(s=>s.part===f.part));
}
