import {z} from 'zod';

const minute=z.number().int().min(0).max(1439);
export const maxTerritoryCountries=50;
export const territoryRegions=z.array(z.string().trim().min(1).max(100).refine(value=>!value.includes('\0'))).max(50)
  .refine(values=>new Set(values.map(value=>value.toLowerCase())).size===values.length);
export const leadDistribution=z.enum(['count','capacity','round_robin']);
export type LeadDistribution=z.infer<typeof leadDistribution>;
export const leadRoutingRule=z.object({
  memberId:z.string().guid(),revision:z.number().int().min(0).max(2147483646),
  available:z.boolean(),country:z.string().trim().max(100),capacity:z.number().int().min(1).max(10000),
  additionalCountries:z.array(z.string().trim().min(1).max(100)).max(maxTerritoryCountries-1).optional(),
  regions:territoryRegions.optional(),
  awayThrough:z.iso.date().refine(value=>value>='0001-01-01','Enter a valid calendar year.').nullable().optional(),
  timeZone:z.string().trim().min(1).max(100),days:z.number().int().min(1).max(127),
  start:minute,end:z.number().int().min(1).max(1440),
}).strict().refine(rule=>!rule.regions?.length||Boolean(rule.country)&&!rule.additionalCountries?.length,
  {message:'Choose one country for a state or province territory.'}).refine(rule=>{
  if(!rule.additionalCountries?.length)return true;
  const countries=[rule.country,...rule.additionalCountries];
  return Boolean(rule.country)&&new Set(countries.map(country=>country.toLowerCase())).size===countries.length;
},{message:'Enter each country once and put the first country in the territory field.'}).refine(rule=>rule.start!==rule.end,{message:'Choose different start and end times, or midnight for both to cover the whole day.'});

export type LeadRoutingRule=z.infer<typeof leadRoutingRule>;
export type LeadRoutingMember=LeadRoutingRule&{label:string};
export const defaultRoutingRule={available:false,awayThrough:null,country:'',additionalCountries:[],regions:[],capacity:25,timeZone:'UTC',days:127,start:0,end:1440};

export const routingReasons={
  paused:'Routing turned off',territory:'Different territory',away:'Away',timeOff:'Scheduled time off',hours:'Outside working hours',
  meeting:'In a team meeting',capacity:'At capacity',ready:'Available',
} as const;
export type RoutingReason=keyof typeof routingReasons;
export type RoutingCounts=Partial<Record<RoutingReason,number>>;
export type RoutingMiss={checkedAt:string;counts:RoutingCounts};
export type LeadRoutingPreview={next:string|null;counts:RoutingCounts;lastMiss?:RoutingMiss};
