import type { DealFunnel } from './deal-funnel';

export type ConversionTime = {count:number;medianDays:number|null;meanDays:number|null};
export type FunnelStepTiming = {converted:ConversionTime;unconverted:{count:number;medianDays:number|null}};
export type FunnelDrillTiming = {mode:'converted'|'unconverted';fromStage:string;toStage:string;cutoff:string};

// The report excludes events after its date range, so unconverted ages must
// stop at the same boundary, even when the report is opened much later.
export function funnelTimingCutoff(f:DealFunnel,asOf:string) {
  const end=f.period==='all'?Infinity:Date.parse(f.to+'T00:00:00Z')+86_400_000;
  return new Date(Math.min(Date.parse(asOf),end)).toISOString();
}
export function formatFunnelDuration(days:number|null|undefined) {
  if(days==null||!Number.isFinite(days))return '—';
  if(days===0)return '0 seconds';
  if(days>0&&days<0.1/86400)return '<0.1 seconds';
  const [value,unit]=days<1/1440?[days*86400,'seconds']:days<1/24?[days*1440,'minutes']:days<1?[days*24,'hours']:[days,'days'];
  return new Intl.NumberFormat(undefined,{style:'unit',unit:unit.slice(0,-1),unitDisplay:'long',maximumFractionDigits:1}).format(value);
}
