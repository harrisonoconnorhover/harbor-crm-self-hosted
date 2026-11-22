import {z} from 'zod';
import {portableCustomPropertyKinds,type PortableCustomPropertyKind} from './portable-custom-properties';

// Shared writes may omit any of these fields. Derived views must honor the same visibility.
export const restrictedStandardFields={
  contacts:['mobilePhone','address','address2','postalCode','description','department','seniority','leadStatus','linkedinUrl','website','preferredLanguage','state','timeZone'],
  companies:['annualRevenue','numberOfEmployees','address','address2','postalCode','description','companyType','targetAccount','icpTier','leadStatus','industry','linkedinUrl','state','timeZone','yearFounded'],
  deals:['amount','closeDate','closedWonReason','closedLostReason','nextStep','description','dealType','priority','forecastCategory'],
} as const satisfies Record<PortableCustomPropertyKind,readonly string[]>;

export function isRestrictableStandardField(kind:PortableCustomPropertyKind,id:string){
  return (restrictedStandardFields[kind] as readonly string[]).includes(id);
}

export const portableStandardAccessWrite=z.object({
  action:z.literal('standardAccess'),kind:portableCustomPropertyKinds,id:z.string().min(1).max(80),
  audience:z.union([z.literal('workspace'),z.literal('owner'),z.string().guid().toLowerCase()]),
  expectedRevision:z.number().int().min(0).max(2147483646),
}).strict().refine(input=>isRestrictableStandardField(input.kind,input.id)||(input.kind==='deals'&&input.id==='stage'),'Choose a supported standard property.');
export type PortableStandardAccessWrite=z.output<typeof portableStandardAccessWrite>;
export type PortableStandardAccess={id:string;audience:string;revision:number};
