import {z} from 'zod';
import {calendarMonth} from './portable-records';
import {forecastTargetSave} from './forecast-targets';
import {fiscalStartMonthSchema,forecastPeriod,forecastSettingsSchema} from './sales-forecast';

const scope=z.object({
  period:z.enum(['month','quarter']).default('month'),
  month:calendarMonth,
  pipelineId:z.union([z.literal('default'),z.string().guid()]),
  owner:z.union([z.literal('all'),z.literal('mine'),z.string().guid()]),
});
export const forecastPageQuery=scope.partial().extend({
  view:z.enum(['forecast','goals']),workspaceId:z.string().guid().optional(),
}).strict();
export const forecastGoalWrite=scope.extend({
  ...forecastTargetSave.pick({amountCents:true,revision:true}).shape,
  fiscalStartMonth:fiscalStartMonthSchema.unwrap().optional(),
}).strict().refine(s=>s.period==='month'||(s.fiscalStartMonth!==undefined&&forecastSettingsSchema.shape.month.safeParse(s.month).success),
  'Choose a supported fiscal quarter and confirm the workspace calendar.');
export const forecastCalendarWrite=z.object({action:z.literal('set_calendar'),start:z.number().int().min(1).max(12),
  expectedStart:z.number().int().min(1).max(12)}).strict();
export function offsetForecastMonth(month:string,offset:number){
  const [year,number]=month.split('-').map(Number);
  return new Date(Date.UTC(year,number-1+offset,1)).toISOString().slice(0,7);
}
export function quarterMonths(month:string,start:string){
  const period=forecastPeriod({month,period:'quarter',fiscalStartMonth:start});
  const months=[0,1,2].map(offset=>offsetForecastMonth(period.from.slice(0,7),offset));
  return {months,label:period.label};
}
export type ForecastScope=z.infer<typeof scope>;
export type GoalWrite=z.infer<typeof forecastGoalWrite>;
