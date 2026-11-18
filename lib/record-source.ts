import type {Data} from './crm';
import type {FilterField} from './filters';

export const recordSources=['Manual entry','Import','API','Workflow','Clone','Sample data','Web form'] as const;
export type RecordSourceData={recordSource?:typeof recordSources[number];recordSourceDetail1?:string};
export const recordSourceFieldIds=['recordSource','recordSourceDetail1'] as const;
export const isRecordSourceField=(id:string)=>recordSourceFieldIds.some(field=>field===id);
export const recordSourceFields:FilterField[]=[
 {id:'recordSource',label:'Record source',type:'select',options:recordSources,group:'Record information',description:'How this record was originally created. Set automatically and retained through edits. Blank means the original source is unknown; this is not website traffic attribution.'},
 {id:'recordSourceDetail1',label:'Record source detail 1',type:'text',group:'Record information',description:'The import, workflow, original cloned record or entry method recorded at creation. Names are snapshots and do not change when their source is renamed.'},
];
// Call only at the trusted creation boundary, after normal input validation.
export function withRecordSource(data:Data,source:NonNullable<RecordSourceData['recordSource']>,detail:string):Data {
 return {...data,recordSource:source,recordSourceDetail1:detail.slice(0,250)};
}
export function retainRecordSource(data:Data,previous?:Data):Data {
 const {recordSource:_source,recordSourceDetail1:_detail,...values}=data;
 return {...values,...(previous?.recordSource?{recordSource:previous.recordSource}:{}),...(previous?.recordSourceDetail1?{recordSourceDetail1:previous.recordSourceDetail1}:{})} as Data;
}
