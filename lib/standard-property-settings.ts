import type {Kind} from './crm';
import type {Property} from './workspace';
import {standardField} from './standard-properties';
import {recordLayoutFields} from './record-layout';

// Only settings edited through standard Options / Date display belong here.
export function standardSettingDefinition(kind:Kind,field:string,setting?:Property):Property|null {
 const dropdown=standardField(kind,field,setting?[setting]:[]);
 if(dropdown?.type==='select')return {id:setting?.id||field,kind,standardField:field,label:dropdown.label,type:'select',options:[...dropdown.options!],revision:setting?.revision||0};
 const date=recordLayoutFields(kind,[]).find(f=>f.id===field&&['date','datetime'].includes(f.type));
 return date?{id:setting?.id||field,kind,standardField:field,label:date.label,type:date.type as 'date'|'datetime',options:[],showRelativeTime:!!setting?.showRelativeTime,revision:setting?.revision||0}:null;
}
