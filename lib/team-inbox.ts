import {z} from 'zod';
import {ticketPriorities} from './crm';
import {emailAddress} from './email/message';

const id=z.string().guid();
const revision=z.number().int().positive().max(2147483646);
const target={id,revision};
export const maxHandoffNoteLength=2000;
export const supportTag=z.string().trim().min(1).max(40).regex(/^[^\p{Cc}]+$/u);
// Older queue links and message pages carry only the UUID. New queue links also
// pin the sort time so another agent can claim the boundary row without moving the page.
const queuePosition=z.string().max(64).refine(value=>{
  if(id.safeParse(value).success)return true;
  const parts=value.split('~');
  return parts.length===2&&id.safeParse(parts[0]).success&&z.iso.datetime({precision:6}).safeParse(parts[1]).success;
});
const searchTerm=z.string().trim().min(1).max(120).regex(/^[^\p{Cc}]+$/u);
export const inboxQueue=z.object({
  status:z.enum(['open','resolved','review','response_due','needs_reply']).optional(),after:queuePosition.optional(),
  waiting:z.enum(['24h','72h']).optional(),
  responseWindow:z.enum(['overdue','due_next_hour']).optional(),
  q:searchTerm.optional(),messageText:searchTerm.optional(),
  claim:z.union([z.enum(['mine','unclaimed']),id]).optional(),mailbox:emailAddress.transform(v=>v.toLowerCase()).optional(),tag:supportTag.optional(),ticketTag:supportTag.toLowerCase().pipe(supportTag).optional(),
}).strict().refine(q=>!q.responseWindow||q.status==='response_due','Choose the first-response queue to filter by deadline.')
  .refine(q=>!q.waiting||q.status==='needs_reply','Choose Needs reply to filter by waiting time.')
  .refine(q=>q.status!=='response_due'||!q.after||q.after.includes('~'),'Choose a page from the first-response queue.');
export const inboxRead=inboxQueue.safeExtend({workspaceId:id.optional(),id:id.optional(),messageId:id.optional(),history:z.enum(['team','notes','handoffs']).optional()})
  .refine(q=>!q.history||Boolean(q.id&&!q.messageId),'Choose a conversation for team history.')
  .refine(q=>!q.messageId||(q.id&&!q.after),'Choose one message in a conversation.').refine(
  q=>!q.id||!(q.q||q.messageText||q.status||q.claim||q.mailbox||q.tag||q.ticketTag||q.after?.includes('~')),'Choose a conversation or a queue.');
export type InboxRead=z.output<typeof inboxRead>;
export const inboxSnippetRead=z.discriminatedUnion('snippets',[
  z.object({snippets:z.literal('1'),workspaceId:id.optional(),id:id.optional()}).strict(),
  z.object({snippets:z.literal('names'),workspaceId:id.optional(),q:searchTerm.optional()}).strict(),
]);
const snippetName=z.string().trim().min(1).max(100).regex(/^[^\p{Cc}]+$/u);
const plainBody=z.string().trim().min(1).max(16000).refine(s=>!s.includes('\0'));
export const supportTags=z.array(supportTag).max(10)
  .refine(v=>new Set(v.map(t=>t.toLowerCase())).size===v.length,'Use distinct tags.');
export const ticketTags=supportTags.transform(tags=>tags.map(tag=>tag.toLowerCase())).pipe(supportTags);
export const inboxWrite=z.discriminatedUnion('action',[
  z.object({id,revision:z.number().int().min(0).max(2147483646),action:z.literal('save_snippet'),name:snippetName,body:plainBody}).strict(),
  z.object({...target,action:z.literal('delete_snippet')}).strict(),
  z.object({...target,action:z.enum(['claim','release','reopen'])}).strict(),
  z.object({...target,action:z.literal('resolve'),linkedTicket:z.object(target).strict().optional()}).strict(),
  z.object({...target,action:z.literal('reopen_ticket'),linkedTicket:z.object(target).strict()}).strict(),
  z.object({...target,action:z.literal('create_ticket'),priority:z.enum(ticketPriorities).default('Medium')}).strict(),
  z.object({...target,action:z.literal('link_ticket'),ticketId:id,ticketRevision:revision}).strict(),
  z.object({...target,action:z.literal('tag_ticket'),linkedTicket:z.object(target).strict(),tags:ticketTags}).strict(),
  z.object({...target,action:z.literal('assign_ticket'),ticketId:id,ticketRevision:revision,assigneeId:z.string().min(1).max(200)}).strict(),
  z.object({...target,action:z.literal('assign'),assigneeId:z.string().min(1).max(200),
    linkedTicket:z.object({id,revision}).strict().optional(),
    note:z.string().trim().max(maxHandoffNoteLength).refine(s=>!s.includes('\0')).optional()}).strict(),
  z.object({...target,action:z.literal('draft_activity')}).strict(),
  z.object({...target,action:z.literal('note'),noteId:id,body:plainBody.max(2000)}).strict(),
  z.object({...target,action:z.literal('tag'),tags:supportTags}).strict(),
  z.object({...target,action:z.literal('reply'),replyId:id,body:plainBody}).strict(),
  z.object({...target,action:z.enum(['confirm_sent','confirm_failed']),replyId:id}).strict(),
]);
export type InboxWrite=z.output<typeof inboxWrite>;
