import {z} from 'zod';
import {timeZoneSchema} from './workspace-settings';

export const accountLanguages={en:'English',de:'Deutsch',es:'Español',fr:'Français',it:'Italiano',ja:'日本語',pt:'Português'} as const;
export const dateFormats={language:'Language default',mdy:'MM/DD/YYYY',dmy:'DD/MM/YYYY',ymd:'YYYY-MM-DD'} as const;
export const numberFormats={language:'Language default','en-US':'1,234.56','de-DE':'1.234,56','fr-FR':'1 234,56'} as const;
export const accountDefaultsSchema=z.object({
  name:z.string().trim().min(1).max(100).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'Use a single-line workspace name.'),
  timeZone:timeZoneSchema,
  currency:z.string().regex(/^[A-Z]{3}$/).refine(value=>supportedCurrencies.includes(value),'Choose a supported currency.'),
  language:z.enum(['en','de','es','fr','it','ja','pt']),
  dateFormat:z.enum(['language','mdy','dmy','ymd']),
  numberFormat:z.enum(['language','en-US','de-DE','fr-FR']),
}).strict();
// Reject well-formed but unknown currency codes that Intl.NumberFormat would echo back as text.
export const supportedCurrencies=Intl.supportedValuesOf('currency');
export type AccountDefaults=z.infer<typeof accountDefaultsSchema>;
export const initialAccountDefaults:AccountDefaults={name:'My workspace',timeZone:'UTC',currency:'USD',language:'en',dateFormat:'language',numberFormat:'language'};
export type AccountDefaultsState={defaults:AccountDefaults;revision:number};
export const saveAccountDefaults=accountDefaultsSchema.extend({revision:z.number().int().min(0).max(2147483646)}).strict();

export function workspaceNumber(value:number|string,settings:AccountDefaults,kind:'number'|'decimal'|'money'|'usd'|'percent'='number'){
  const locale=settings.numberFormat==='language'?settings.language:settings.numberFormat;
  const options:Intl.NumberFormatOptions=kind==='money'||kind==='usd'?{style:'currency',currency:kind==='usd'?'USD':settings.currency}:
    kind==='decimal'?{minimumFractionDigits:2,maximumFractionDigits:2}:kind==='percent'?{style:'percent',maximumFractionDigits:1}:{};
  return new Intl.NumberFormat(locale,options).format(value as number);
}

export function workspaceDate(value:string|number,settings:AccountDefaults,withTime=true){
  const day=typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
  const date=new Date(day?value+'T00:00:00Z':value);
  if(!Number.isFinite(date.valueOf()))return '—';
  const timeZone=day?'UTC':settings.timeZone;
  if(settings.dateFormat==='language'){
    return new Intl.DateTimeFormat(settings.language,{timeZone,dateStyle:'medium',...(withTime&&!day?{timeStyle:'short'}:{})}).format(date);
  }
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(p=>[p.type,p.value]));
  const formatted=settings.dateFormat==='ymd'?[parts.year,parts.month,parts.day].join('-'):
    (settings.dateFormat==='dmy'?[parts.day,parts.month,parts.year]:[parts.month,parts.day,parts.year]).join('/');
  return withTime&&!day?formatted+' · '+new Intl.DateTimeFormat(settings.language,{timeZone,timeStyle:'short'}).format(date):formatted;
}
