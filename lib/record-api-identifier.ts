import {uniqueNumber} from './unique-number';
import {z} from 'zod';
import {customTextLimit} from './property-text';

export type RecordIdentifier={propertyId:string;value:string};
export function parseRecordIdentifier(params:URLSearchParams,pathId?:string):RecordIdentifier|undefined {
 const selectors=params.getAll('idProperty'),values=params.getAll('idValue');
 if(!selectors.length&&!values.length)return undefined;
 if(selectors.length!==1||values.length>1)throw Error('Supply exactly one idProperty and one identifier value.');
 const field=selectors[0];
 if(!field.startsWith('custom:')||!z.string().guid("Invalid uuid").safeParse(field.slice(7)).success)throw Error('idProperty must be custom:<property ID> for a unique property.');
 if(pathId!==undefined&&values.length)throw Error('Supply the identifier in the URL path or idValue, not both.');
 if(pathId===undefined&&values.length!==1)throw Error('Include idValue when looking up a record at the object endpoint.');
 if(params.has('limit')||params.has('after'))throw Error('Pagination cannot be combined with a unique-property lookup.');
 const value=pathId??values[0];
 if(!value||value.length>customTextLimit)throw Error('Supply a non-empty identifier within the property text limit.');
 return {propertyId:field.slice(7).toLowerCase(),value};
}
export function identifierValue(type:string,value:string):string|number {
 if(type!=='number')return value;
 return uniqueNumber(value);
}
