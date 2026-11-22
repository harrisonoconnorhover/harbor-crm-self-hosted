import {z} from 'zod';
import {marketingAudienceFilter} from './marketing-audience';

export const marketingCampaignInput=z.object({
  action:z.literal('queue'),id:z.uuid(),name:z.string().trim().min(1).max(120),
  designId:z.uuid(),designRevision:z.number().int().positive(),
  filter:marketingAudienceFilter,sendAfter:z.number().int().positive().max(8640000000000000).optional(),expectedTotal:z.number().int().positive(),
  snapshot:z.uuid(),
}).strict();
export type MarketingCampaignInput=z.infer<typeof marketingCampaignInput>;
export type MarketingCampaignSummary={id:string;name:string;paused:boolean;active:boolean;sourceChanged:boolean;audienceSize:number;
  createdAt:number;sendAfter:number|null;states:Record<string,number>};
export type MarketingIssue={id:string;dueAt:number;attempts:number;campaignId:string;campaignName:string;email:string;state:string;lastIssue:string|null};

// The timestamp and UUID identify a boundary even if the boundary row is resolved.
const activityCursor=z.string().max(56).transform(value=>value.split(':'))
  .pipe(z.tuple([z.string().regex(/^\d{1,16}$/).transform(Number).pipe(z.number().int().nonnegative().safe()),z.uuid()]))
  .transform(([at,id])=>({at,id}));
export const marketingActivityQuery=z.object({campaignAfter:activityCursor.optional(),issueAfter:activityCursor.optional()}).strict();
export type ActivityCursor=z.output<typeof activityCursor>;
export type MarketingActivityPage={campaigns:MarketingCampaignSummary[];issues:MarketingIssue[];
  campaignNext:string|null;issueNext:string|null;providerRetryAtMs:number|null};

export const recipientHistoryQuery=z.object({
  action:z.literal('recipientHistory'),email:z.string().trim().toLowerCase().max(320).pipe(z.email()),
  after:z.object({createdAt:z.number().int().nonnegative().safe(),id:z.uuid()}).strict().optional(),
}).strict();
export type RecipientHistoryQuery=z.infer<typeof recipientHistoryQuery>;
export type RecipientHistoryPage={
  items:{id:string;name:string;createdAt:number;state:string;attempts:number;providerId:string|null;lastIssue:string|null}[];
  next:NonNullable<RecipientHistoryQuery['after']>|null;
};
