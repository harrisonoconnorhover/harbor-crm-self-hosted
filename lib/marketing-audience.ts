import {z} from 'zod';

// SOQL identifiers in this connector are a single object or field API name.
// Segmentation values are always parameters in PostgreSQL, never SOQL fragments.
const apiName=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/, 'Use a Salesforce field or object API name.');
const fields=z.array(apiName).max(12).refine(names=>new Set(names.map(name=>name.toLowerCase())).size===names.length,
  'Each mapped field must be unique.');
export const salesforceAudienceMapping=z.object({
  consentField:apiName,
  accountFields:fields,
  related:z.object({object:apiName,accountField:apiName,fields:fields.refine(names=>names.length>0)}).strict().optional(),
}).strict().refine(input=>!['id','accountid','email','hasoptedoutofemail'].includes(input.consentField.toLowerCase()),
  'Choose an independent affirmative consent checkbox.');
export type SalesforceAudienceMapping=z.infer<typeof salesforceAudienceMapping>;

const fieldMatch=z.object({field:apiName,value:z.string().min(1).max(500)}).strict();
export const marketingAudienceFilter=z.object({account:fieldMatch.optional(),related:fieldMatch.optional()}).strict();
export type MarketingAudienceFilter=z.infer<typeof marketingAudienceFilter>;

export type MarketingFields=Record<string,string|number|boolean|null>;
export type SalesforceAudiencePage=
  | {kind:'contacts';rows:{id:string;email:string|null;accountId:string|null;eligible:boolean}[]}
  | {kind:'accounts';rows:{id:string;fields:MarketingFields}[]}
  | {kind:'related';rows:{id:string;accountId:string|null;fields:MarketingFields}[]};
export interface SalesforceAudienceSource{
  origin?:string;
  mapping: SalesforceAudienceMapping;
  pages(): AsyncIterable<SalesforceAudiencePage>;
}

export type MarketingAudienceStatus={
  state:'missing'|'syncing'|'failed'|'ready'|'stale';
  generation:string|null;
  startedAt:string|null;
  completedAt:string|null;
  contacts:number;
  accounts:number;
  related:number;
  mapping:SalesforceAudienceMapping|null;
};
