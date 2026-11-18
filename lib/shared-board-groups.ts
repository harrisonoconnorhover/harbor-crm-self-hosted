import {z} from 'zod';
import type {RecordBoardSummary} from './shared-record-board';
import {stageMoveFields,type StageMoveKind} from './shared-record-stage-move';
export const boardGroupId=z.string().min(1).max(150).regex(/^(stage|[a-zA-Z][a-zA-Z0-9]*|custom:[a-zA-Z0-9_-]{1,100})$/);
const laneIds=z.array(z.string().max(1000)).max(100).refine(v=>new Set(v).size===v.length,'Choose each lane once.').default([]);
export const boardLaneSettings=z.object({groupBy:boardGroupId.default('stage'),order:laneIds,hidden:laneIds,collapsed:laneIds}).strict().prefault({});
export type BoardLaneSettings=z.infer<typeof boardLaneSettings>;
export const boardGroupCatalogQuery=z.object({workspaceId:z.string().guid("Invalid uuid"),kind:z.enum(['deals','tickets','leads']),query:z.string().trim().max(160).default(''),after:z.string().max(150).default(''),selected:boardGroupId.default('stage')}).strict();
export type BoardGroupField={id:string;label:string};
export const groupValueId=(value:string)=>JSON.stringify(value?['value',value]:['missing']);
export function visibleBoardLanes(lanes:RecordBoardSummary['lanes'],settings:BoardLaneSettings){const rank=new Map(settings.order.map((id,i)=>[id,i]));return lanes.filter(l=>!settings.hidden.includes(l.id)).sort((a,b)=>(rank.get(a.id)??settings.order.length)-(rank.get(b.id)??settings.order.length))}
export type SharedGroupMove={kind:StageMoveKind;pipelineId:string;field:string;fromValue:string;toValue?:string;updatedAt:string};
export function groupMoveProblem(move:SharedGroupMove,record:{kind:string;updatedAt:string;fields:{id:string;value:unknown;type:string;options?:readonly string[]}[]}){
 const field=record.fields.find(f=>f.id===move.field),pipeline=record.fields.find(f=>f.id===stageMoveFields[move.kind].pipeline);
 if(record.kind!==move.kind||record.updatedAt!==move.updatedAt||String(pipeline?.value||'default')!==move.pipelineId||String(field?.value??'')!==move.fromValue)return 'This card changed. Close this form and refresh the board before moving it.';
 if(!field||field.type!=='select')return 'The grouping property is unavailable. Refresh the board.';
 if(move.toValue!==undefined&&move.toValue!==''&&!field.options?.includes(move.toValue))return 'The destination value is unavailable. Refresh the board.';
 return '';
}
