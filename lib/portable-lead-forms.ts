import {z} from 'zod';
import {leadFormAction,leadFormDefinition,leadSubmissionFilter} from './lead-forms';
import {portableRecordSearch} from './portable-records';

const definition=leadFormDefinition.extend({automationNote:z.string().trim().min(1).max(2000).optional()});
const [save,...other]=leadFormAction.options;
export const portableLeadFormAction=z.discriminatedUnion('action',[save.extend({definition}),...other]);
export type PortableLeadFormDefinition=z.output<typeof definition>;
export const portableInquiryFilter=leadSubmissionFilter.or(z.enum(['note_issues','overdue']));
export type PortableInquiryFilter=z.output<typeof portableInquiryFilter>;
export const portableInquirySearch=z.preprocess(value=>typeof value==='string'?value.trim()||undefined:value,
  portableRecordSearch.refine(value=>!value.includes('\0')).optional());
export type LeadFormReviewReason='duplicate_email'|'archived_contact';
export const formNoteCapacityIssue='This workspace has too many pending form Notes.';
export type LeadFormNoteAutomation={
  status:'awaiting_contact'|'waiting'|'queued'|'succeeded'|'skipped'|'failed';
  issue:string|null;
  overdue?:true;
  claimExpired?:true;
  attentionJobId?:string;
};

export function leadFormAutomationNote(definition:PortableLeadFormDefinition){
  return definition.queueWorkflows===true&&definition.captureContacts===true?definition.automationNote:undefined;
}
