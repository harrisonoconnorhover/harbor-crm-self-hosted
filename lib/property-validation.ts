import {propertyRegexError,matchesPropertyRegex,propertyRegexLimit,propertyRegexValueLimit} from './property-regex';
import {isLinkProperty,propertyDomainSchema,propertyLinkDomain} from './property-links';
import {z} from 'zod';
import {customTextLimit,isTextProperty} from './property-text';

export const validationRulesSchema=z.object({
 regex:z.string().min(1).max(propertyRegexLimit).optional(),
 regexMessage:z.string().trim().min(1).max(100).optional(),
 regexHelp:z.string().trim().max(350).optional(),
 domainMode:z.enum(['any','allow','block']).optional(),
 domains:z.array(propertyDomainSchema).max(100).optional(),
 whitespace:z.enum(['any','trim','none']).optional(),
 characters:z.enum(['any','numeric','alphanumeric']).optional(),
 casing:z.enum(['any','upper','lower','title']).optional(),
 autoRemove:z.boolean().optional(),
 minLength:z.number().int().min(0).max(customTextLimit).optional(),
 maxLength:z.number().int().min(0).max(customTextLimit).optional(),
 min:z.number().finite().optional(),
 max:z.number().finite().optional(),
 decimals:z.number().int().min(0).max(10).optional(),
 dateMode:z.enum(['any','future','past','range']).optional(),
 bufferDays:z.number().int().min(0).max(3650).optional(),
 rollingDays:z.number().int().min(1).max(3650).optional(),
 dateFrom:z.string().date().optional(),
 dateTo:z.string().date().optional(),
 weekdaysOnly:z.boolean().optional(),
}).strict();
export type ValidationRules=z.infer<typeof validationRulesSchema>;
type ValidatedField={label:string;type:string;validation?:ValidationRules|null;validationTimeZone?:string};
export function definitionValidationError(type:string,rules?:ValidationRules|null):string|null{
 if(!rules)return null;
 const keys=Object.keys(rules).filter(k=>rules[k as keyof ValidationRules]!==undefined);
 const allowed=isLinkProperty(type)?['domainMode','domains']:isTextProperty(type)?['regex','regexMessage','regexHelp','minLength','maxLength','whitespace','characters','casing','autoRemove']:type==='number'?['min','max','decimals']:type==='date'?['dateMode','bufferDays','rollingDays','dateFrom','dateTo','weekdaysOnly']:[];
 if(keys.some(k=>!allowed.includes(k)))return 'Choose validation rules that match the property type.';
 if(rules.regex!==undefined){
  if(keys.some(k=>!['regex','regexMessage','regexHelp'].includes(k)))return 'Choose either basic text rules or a custom regex.';
  const error=propertyRegexError(rules.regex);if(error)return error;
  if(!rules.regexMessage?.trim())return 'Enter an invalid value message for the custom rule.';
 }else if(rules.regexMessage!==undefined||rules.regexHelp!==undefined)return 'Enter a custom regex before setting its messages.';
 if(rules.minLength!==undefined&&rules.maxLength!==undefined&&rules.minLength>rules.maxLength)return 'Minimum length cannot exceed maximum length.';
 if(rules.min!==undefined&&rules.max!==undefined&&rules.min>rules.max)return 'Minimum value cannot exceed maximum value.';
 if(rules.autoRemove&&(!rules.characters||rules.characters==='any'))return 'Automatic removal requires numbers only or no symbols.';
 if(isLinkProperty(type)){
  if(rules.domainMode&&rules.domainMode!=='any'&&!rules.domains?.length)return 'Enter at least one allowed or blocked domain.';
  if((!rules.domainMode||rules.domainMode==='any')&&rules.domains?.length)return 'Choose allowed or blocked domains for a domain list.';
  if(rules.domains&&new Set(rules.domains).size!==rules.domains.length)return 'Enter each domain once.';
 }
 if(type==='date'){
  if(rules.dateMode==='range'){
   if(!rules.dateFrom||!rules.dateTo)return 'Choose both the first and last allowed dates.';
   if(rules.dateFrom>rules.dateTo)return 'The first allowed date cannot be after the last allowed date.';
  }else if(rules.dateFrom!==undefined||rules.dateTo!==undefined)return 'Use a specific date range for fixed date boundaries.';
  if(rules.dateMode!=='future'&&(rules.bufferDays!==undefined||rules.rollingDays!==undefined))return 'Buffer and rolling days require future dates only.';
  if(rules.bufferDays!==undefined&&rules.rollingDays!==undefined)return 'Choose either a buffer or a rolling date range.';
 }
 return null;
}
export function normalizedValidation(rules?:ValidationRules|null):ValidationRules|null{
 if(!rules)return null;
 const value=Object.fromEntries(['regex','regexMessage','regexHelp','domainMode','domains','whitespace','characters','casing','autoRemove','minLength','maxLength','min','max','decimals','dateMode','bufferDays','rollingDays','dateFrom','dateTo','weekdaysOnly'].flatMap(k=>rules[k as keyof ValidationRules]===undefined||(['domainMode','whitespace','characters','casing','dateMode'].includes(k)&&rules[k as keyof ValidationRules]==='any')||rules[k as keyof ValidationRules]===false?[]:[[k,rules[k as keyof ValidationRules]]]));
 return Object.keys(value).length?value:null;
}
// These are character rules, not number parsing: retain leading zeroes and formatting.
const nonNumeric=/[^\p{Nd}.,+\-]/gu;
const nonAlphanumeric=/[^\p{L}\p{M}\p{Nd}\p{Zs}\u200c\u200d\r\n]/gu;
export function formatPropertyText(field:ValidatedField,value:string):string{
 const r=field.validation;if(!r?.autoRemove||!isTextProperty(field.type))return value;
 let next=r.characters==='numeric'?value.replace(nonNumeric,''):r.characters==='alphanumeric'?value.replace(nonAlphanumeric,''):value;
 if(r.whitespace==='trim')next=next.trim();
 if(r.whitespace==='none')next=next.replace(/\s/gu,'');
 return next;
}
function titleCased(value:string){
 // Capitalize the start of a word; retain names, acronyms and number-led words.
 return value.split(/[\s\p{Pd}]+/u).every(word=>{
  const first=word.match(/[\p{L}\p{Nd}]/u)?.[0];
  return !first||/\p{Nd}/u.test(first)||first.toUpperCase()===first.toLowerCase()||/^[\p{Lu}\p{Lt}]$/u.test(first);
 });
}
export function decimalPlaces(value:number){
 const [mantissa,exponent='0']=String(value).toLowerCase().split('e');
 return Math.max(0,(mantissa.split('.')[1]?.length||0)-Number(exponent));
}
export function validationCalendarDay(now:Date,timeZone='UTC'){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const get=(type:string)=>parts.find(p=>p.type===type)!.value;
 return `${get('year')}-${get('month')}-${get('day')}`;
}
export function addCalendarDays(day:string,days:number){
 const date=new Date(day+'T00:00:00.000Z');date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);
}
export function propertyValidationError(field:ValidatedField,value:unknown,options:{now?:Date;ignoreRelative?:boolean}={}):string|null{
 const r=field.validation;
 if(!r||value===null||value===undefined||value==='')return null;
 if(isLinkProperty(field.type)&&r.domainMode&&r.domainMode!=='any'){
  const domain=propertyLinkDomain(field.type,value);
  const matches=!!domain&&!!r.domains?.some(allowed=>domain===allowed||domain.endsWith('.'+allowed));
  if(domain&&((r.domainMode==='allow'&&!matches)||(r.domainMode==='block'&&matches)))return `Use ${r.domainMode==='allow'?'an allowed':'a non-blocked'} domain for ${field.label}.`;
 }
 if(isTextProperty(field.type)&&typeof value==='string'){
  if(r.regex!==undefined){
   if(value.length>propertyRegexValueLimit)return `Use at most ${propertyRegexValueLimit.toLocaleString('en-US')} characters for ${field.label} when a custom regex is enabled.`;
   if(propertyRegexError(r.regex))return `The custom rule for ${field.label} is invalid. Update its validation settings.`;
   if(!matchesPropertyRegex(r.regex,value))return `${field.label}: ${r.regexMessage||'Enter a value matching the required format.'}${r.regexHelp?' '+r.regexHelp:''}`;
  }
  if(r.whitespace==='trim'&&value!==value.trim())return `Remove leading and trailing whitespace from ${field.label}.`;
  if(r.whitespace==='none'&&/\s/u.test(value))return `Remove all whitespace from ${field.label}.`;
  if(r.characters==='numeric'&&(value.replace(nonNumeric,'')!==value||! /\p{Nd}/u.test(value)))return `Use numbers only (digits and . , + -) for ${field.label}.`;
  if(r.characters==='alphanumeric'&&value.replace(nonAlphanumeric,'')!==value)return `Use letters, digits, spaces and line breaks only for ${field.label}.`;
  if(r.casing==='upper'&&value!==value.toUpperCase())return `Use uppercase letters for ${field.label}.`;
  if(r.casing==='lower'&&value!==value.toLowerCase())return `Use lowercase letters for ${field.label}.`;
  if(r.casing==='title'&&!titleCased(value))return `Use title casing for ${field.label} (capitalize the first letter of each word).`;
  if(r.minLength!==undefined&&value.length<r.minLength)return `Use at least ${r.minLength} characters for ${field.label}.`;
  if(r.maxLength!==undefined&&value.length>r.maxLength)return `Use at most ${r.maxLength} characters for ${field.label}.`;
 }
 if(field.type==='number'&&typeof value==='number'){
  if(r.min!==undefined&&value<r.min)return `Use a value of at least ${r.min} for ${field.label}.`;
  if(r.max!==undefined&&value>r.max)return `Use a value of at most ${r.max} for ${field.label}.`;
  if(r.decimals!==undefined&&decimalPlaces(value)>r.decimals)return `Use at most ${r.decimals} decimal places for ${field.label}.`;
 }
 if(field.type==='date'&&typeof value==='string'){
  if(r.dateMode==='range'&&(value<r.dateFrom!||value>r.dateTo!))return `Use a date from ${r.dateFrom} through ${r.dateTo} for ${field.label}.`;
  const weekday=new Date(value+'T00:00:00.000Z').getUTCDay();
  if(r.weekdaysOnly&&(weekday===0||weekday===6))return `Use a Monday–Friday date for ${field.label}.`;
  if(!options.ignoreRelative&&(r.dateMode==='future'||r.dateMode==='past')){
   const zone=field.validationTimeZone||'UTC',today=validationCalendarDay(options.now||new Date(),zone);
   if(r.dateMode==='past'&&value>=today)return `Use a date before ${today} (${zone}) for ${field.label}.`;
   if(r.dateMode==='future'){
    const first=addCalendarDays(today,1+(r.bufferDays||0));
    if(value<first)return `Use ${first} or a later date (${zone}) for ${field.label}.`;
    if(r.rollingDays!==undefined){const last=addCalendarDays(today,r.rollingDays);if(value>last)return `Use ${last} or an earlier date (${zone}) for ${field.label}.`;}
   }
  }
 }
 return null;
}
export function validationSummary(rules?:ValidationRules|null){
 if(!rules)return '';
 if(rules.regex!==undefined)return `Custom regex: ${rules.regex} · Invalid value: ${rules.regexMessage||'Required format'}${rules.regexHelp?' · '+rules.regexHelp:''}`;
 const labels:Record<string,string>={minLength:'Minimum characters',maxLength:'Maximum characters',min:'Minimum value',max:'Maximum value',decimals:'Maximum decimal places'};
 const parts=Object.entries(rules).filter(([k,v])=>k in labels&&v!==undefined).map(([k,v])=>`${labels[k]}: ${v}`);
 if(rules.domainMode&&rules.domainMode!=='any')parts.push(`${rules.domainMode==='allow'?'Allowed':'Blocked'} domains (including subdomains): ${(rules.domains||[]).join(', ')}`);
 if(rules.whitespace==='trim')parts.push('No leading or trailing whitespace');
 if(rules.whitespace==='none')parts.push('No whitespace');
 if(rules.characters==='numeric')parts.push('Numbers only');
 if(rules.characters==='alphanumeric')parts.push('No symbols or special characters');
 if(rules.casing&&rules.casing!=='any')parts.push({upper:'Uppercase only',lower:'Lowercase only',title:'Title casing'}[rules.casing]);
 if(rules.autoRemove)parts.push('Automatically remove disallowed characters and spaces in manual edits and imports');
 if(rules.dateMode==='future')parts.push(rules.bufferDays!==undefined?`Future dates after ${rules.bufferDays} full buffer days`:rules.rollingDays!==undefined?`Next ${rules.rollingDays} days (excluding today)`:'Future dates only (excluding today)');
 if(rules.dateMode==='past')parts.push('Past dates only (excluding today)');
 if(rules.dateMode==='range')parts.push(`From ${rules.dateFrom} through ${rules.dateTo}`);
 if(rules.weekdaysOnly)parts.push('Monday–Friday only');
 return parts.join(' · ');
}
