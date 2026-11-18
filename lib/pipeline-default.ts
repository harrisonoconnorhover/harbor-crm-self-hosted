import {leadPipelines} from './lead-pipelines';
import {pipelineList,isPipelineSettings,type DealStageSource} from './forecast';
import {ticketCatalog} from './ticket-pipelines';
import type {Kind} from './crm';
export function defaultPipelineId(kind:Kind,source?:DealStageSource):string{
 if(kind==='leads')return leadPipelines(source).find(p=>p.isDefault)?.id??'default';
 if(kind!=='deals'&&kind!=='tickets')return 'default';
 const pipelines=kind==='tickets'?ticketCatalog(source).pipelines:source&&isPipelineSettings(source)?pipelineList(source):[];
 return pipelines.find(p=>p.isDefault)?.id??'default';
}
export function setPipelineDefault<T extends {id:string;isDefault?:boolean}>(pipelines:T[],id?:string):T[]{
 if(id===undefined)return pipelines;
 if(!pipelines.some(p=>p.id===id))throw Error('Choose an available default pipeline.');
 return pipelines.map(p=>({...p,isDefault:p.id===id}));
}
