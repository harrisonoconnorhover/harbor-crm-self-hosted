import {and,eq,isNotNull} from 'drizzle-orm';
import {portableJobs as jobs} from './job-schema';
import {scheduledGmail as mail} from './scheduled-gmail-schema';

export const scheduledGmailReceiptJoin=and(eq(jobs.workspaceId,mail.workspaceId),eq(jobs.id,mail.jobId));

// Reconciliation updates the job's finish time. The original dispatch time remains the outreach date.
export const confirmedScheduledGmailReceipt=and(eq(jobs.kind,'gmail'),eq(jobs.status,'succeeded'),
  isNotNull(mail.providerId),isNotNull(mail.dispatchStartedAt));
