import {z} from 'zod';
import {utcDateTime} from './iso-date-time';
import {CONTACT_NAME_MAX} from './crm';
import {emailAddress} from './email/message';
import {ApiError} from './api-error';
export const LEAD_FORM_DAILY_LIMIT=100;
export const LEAD_FORM_HOURLY_LIMIT=30;
export const supersededLeadFormCode='superseded_form';
export class SupersededLeadFormError extends ApiError {
 constructor(){super(409,'This form changed. Reload it before submitting.');}
}
export const leadFormCursor=z.object({at:utcDateTime,id:z.string().guid("Invalid uuid")}).strict();
export const leadFormDefinition=z.object({title:z.string().trim().min(1).max(100),description:z.string().trim().max(1000).default(''),thankYou:z.string().trim().min(1).max(500).default('Thank you. Your inquiry has been received.'),captureContacts:z.boolean().optional(),showMessageOnContact:z.boolean().optional(),queueWorkflows:z.boolean().default(false),embedOrigin:z.string().trim().max(254).optional()}).strict();
export const leadFormPayload=z.object({name:z.string().trim().min(1).max(CONTACT_NAME_MAX),email:emailAddress.transform(value=>value.toLowerCase()),phone:z.string().trim().max(60).default(''),message:z.string().trim().max(4000).default('')}).strict();
export const leadFormSubmit=z.object({id:z.string().guid("Invalid uuid"),revision:z.number().int().positive(),payload:leadFormPayload,website:z.string().max(100).default('')}).strict();
export const leadFormAction=z.discriminatedUnion('action',[
 z.object({action:z.literal('save'),id:z.string().guid("Invalid uuid"),revision:z.number().int().nonnegative(),definition:leadFormDefinition}).strict(),
 z.object({action:z.literal('setEnabled'),id:z.string().guid("Invalid uuid"),revision:z.number().int().positive(),enabled:z.boolean()}).strict(),
 z.object({action:z.literal('retry'),formId:z.string().guid("Invalid uuid"),submissionId:z.string().guid("Invalid uuid")}).strict(),
 z.object({action:z.literal('setInquiryHandled'),formId:z.string().guid("Invalid uuid"),submissionId:z.string().guid("Invalid uuid"),
  handled:z.boolean(),triageRevision:z.number().int().min(0).max(2147483646)}).strict(),
 z.object({action:z.literal('removeInquiry'),formId:z.string().guid("Invalid uuid"),submissionId:z.string().guid("Invalid uuid")}).strict(),
]);
export type LeadFormDefinition=z.infer<typeof leadFormDefinition>;
export type LeadFormPayload=z.infer<typeof leadFormPayload>;
export type LeadForm={id:string;definition:LeadFormDefinition;enabled:boolean;revision:number;createdAt:string;updatedAt:string;url:string|null};
export type LeadFormSubmission={id:string;formId:string;formTitle:string;payload:LeadFormPayload|null;contactId:string;status:string;reviewReason:string;createdAt:string;removedAt:string;handled:boolean;triageRevision:number;contactAvailable:boolean};
export const unmatchedLeadSubmissionStatuses=['inbox_only','needs_review'] as const;
export const leadSubmissionFilter=z.enum(['all','needs_review','unmatched','open','handled']);
export type LeadSubmissionFilter=z.infer<typeof leadSubmissionFilter>;
export type LeadSubmissionPage={results:LeadFormSubmission[];next:string|null;total:number;needsReview:number};
