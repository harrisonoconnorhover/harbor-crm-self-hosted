import {boardSummaryMetric,type CustomBoardMetricDefinition,type CustomBoardMetricValue} from './shared-board-summary';
import {boardGroupId} from './shared-board-groups';
import type {BoardAmounts} from './shared-board-amounts';
import {z} from 'zod';
import {utcDateTime} from './iso-date-time';
import {sharedListQuery} from './shared-record-list';
export const recordBoardInput=z.object({metrics:z.array(boardSummaryMetric).max(3).refine(v=>new Set(v).size===v.length).optional(),query:sharedListQuery,groupBy:boardGroupId.default('stage'),lane:z.string().max(1000).optional(),asOf:utcDateTime.optional()}).strict().superRefine((v,c)=>{
 if(!['deals','tickets','leads'].includes(v.query.kind)||!v.query.pipelineId||v.query.operation!=='page')c.addIssue({code:'custom',message:'Choose a pipeline for this board.'});
 if(v.lane===undefined&&v.query.after)c.addIssue({code:'custom',message:'Board summaries do not accept a page cursor.'});
 if(v.lane!==undefined&&!v.asOf)c.addIssue({code:'custom',message:'Refresh the board before opening a lane.'});
});
export type RecordBoardInput=z.infer<typeof recordBoardInput>;
export type RecordBoardSummary={metricDefinitions?:CustomBoardMetricDefinition[];group?:{id:string;label:string};asOf:string;total:number;amounts?:BoardAmounts;lanes:{id:string;label:string;count:number;available:boolean;value?:string;customMetrics?:Record<string,CustomBoardMetricValue>;amounts?:BoardAmounts}[]};
