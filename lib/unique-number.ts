import {InputError} from './input-error';
import type {Property} from './workspace';

export const uniqueNumberMessage='This numeric identifier cannot be stored exactly. Use a text unique property for long or high-precision identifiers.';
const decimal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
// Compare decimal values without expanding exponents or converting their digits
// to floating point. 01.00, 1e0 and 1 are the same identifier.
function canonicalDecimal(text:string):string {
 const negative=text.startsWith('-');
 const [mantissa,exponent='0']=text.replace(/^[+-]/,'').toLowerCase().split('e');
 const [whole,fraction='']=mantissa.split('.');
 let digits=(whole+fraction).replace(/^0+/,'');
 if(!digits)return '0';
 const trimmed=digits.replace(/0+$/,'');
 const power=Number(exponent)-fraction.length+digits.length-trimmed.length;
 return `${negative?'-':''}${trimmed}e${power}`;
}
export function numberRoundTrips(text:string,value:number):boolean {
 return decimal.test(text)&&Number.isFinite(value)&&canonicalDecimal(text)===canonicalDecimal(String(value));
}
export function uniqueNumber(value:string|number):number {
 const text=String(value).trim(),number=Number(text);
 if(!decimal.test(text)||!Number.isFinite(number))throw new InputError('Use a finite decimal number for this unique identifier.');
 if(!numberRoundTrips(text,number)||Math.abs(number)>Number.MAX_SAFE_INTEGER)throw new InputError(uniqueNumberMessage);
 return number===0?0:number;
}

// JSON.parse otherwise discards the offending digits before validation sees
// them. Only unique-number write locations retain lossy tokens as text; ordinary
// numeric fields and stale-value expectations keep their existing types.
export function uniqueNumberJson(text:string,properties:Property[], batchNumericIdentifiers=false):unknown {
 const ids=new Set(properties.filter(p=>p.uniqueValues&&p.type==='number'&&!p.standardField).map(p=>p.id));
 return JSON.parse(text,function(key,value,context?:{source?:string}){
  const field=typeof this?.field==='string'?this.field:'';
  const unique=batchNumericIdentifiers&&key==='id'||ids.has(key)||key.startsWith('custom:')&&ids.has(key.slice(7))||key==='value'&&field.startsWith('custom:')&&ids.has(field.slice(7));
  if(typeof value!=='number'||!unique)return value;
  if(!context?.source)throw new InputError('Exact numeric identifier parsing is unavailable. Send this identifier as a decimal string.');
  return numberRoundTrips(context.source,value)?value:context.source;
 });
}

export function uniqueNumberList(text:string):unknown {
 return JSON.parse(text,(_key,value,context?:{source?:string})=>{
  if(typeof value!=='number')return value;
  if(!context?.source)throw new InputError('Use quoted decimal strings in this identifier list.');
  return context.source;
 });
}
