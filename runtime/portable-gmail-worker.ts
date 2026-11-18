import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {z} from 'zod';
import {beginGmailDispatch,checkGmailDeadlineBeforeRefresh,finishGmailDispatch,gmailReconciliationTarget,gmailSendGraceMs,portableGmailMessageId,
  recordGmailReconciliation,rejectGmailMailbox,skipSuppressedGmailBeforeRefresh} from '../db/postgres/scheduled-gmail-store';
import {gmailReauthorizationIssue,type Claim} from '../db/postgres/job-store';
import {GMAIL_SCOPES,GmailError,findSentGmail,sendGmail} from '../lib/email/gmail';
import {emailContent} from '../lib/email/message';
import {appendUnsubscribeFooter} from '../lib/email/unsubscribe';
import {closePortableDb,portableDb} from './portable-db';
import {portableGmailAccessToken,portableGmailConfig,portableWorkflowGmailOwner} from './portable-gmail-config';

export async function runPortableGmailJob(db:PostgresJsDatabase,claim:Claim,signal?:AbortSignal){
  const config=portableGmailConfig();
  if(!config){await rejectGmailMailbox(db,claim);return;}
  const workflowEnabled=portableWorkflowGmailOwner()===config.owner;
  if(claim.segmentEntryRevision!==null&&!workflowEnabled){
    await beginGmailDispatch(db,claim,config.owner,false);
    return;
  }
  if(await skipSuppressedGmailBeforeRefresh(db,claim,config.owner))return;
  if(!await checkGmailDeadlineBeforeRefresh(db,claim))return;
  let token:string;
  try{token=await portableGmailAccessToken(config,GMAIL_SCOPES);}
  catch(error){
    if(error instanceof GmailError&&error.code==='unavailable')throw error;
    const issue=error instanceof GmailError&&error.code==='reauth'?gmailReauthorizationIssue:'gmail_mailbox_unavailable';
    await rejectGmailMailbox(db,claim,issue);
    return;
  }
  const dispatchStarted=performance.now();
  const message=await beginGmailDispatch(db,claim,config.owner,workflowEnabled);
  if(!message)return;
  const sendWithinBudget:typeof fetch=(url,init)=>{
    // Counting from before the database check covers a delayed commit reply without assuming synchronized clocks.
    if(signal?.aborted||performance.now()-dispatchStarted>=message.sendBefore-message.at){
      throw Error('Scheduled Gmail dispatch is no longer current.');
    }
    return fetch(url,init);
  };
  let providerId:string|undefined;
  try{
    const plain=emailContent.parse({to:[message.recipient],subject:message.subject,body:message.body});
    const content=appendUnsubscribeFooter(plain,config.origin+'/email/unsubscribe#'+message.token);
    const receipt=await sendGmail(token,content,config.owner,message.messageId,new Date(message.at).toISOString(),sendWithinBudget);
    providerId=receipt.id;
  }catch{
    // Anything after the dispatch boundary needs confirmation. It must never re-enter the send queue.
  }
  await finishGmailDispatch(db,claim,providerId);
}

export async function reconcilePortableGmail(workspaceId:string,id:string){
  try{
    const config=portableGmailConfig();
    const key=z.object({workspaceId:z.string().guid("Invalid uuid"),id:z.string().guid("Invalid uuid")}).parse({workspaceId,id});
    if(!config)return 'unavailable';
    const db=portableDb(),target=await gmailReconciliationTarget(db,key,config.owner);
    if(target?.status==='succeeded')return 'confirmed';
    if(target?.status!=='attention')return 'unavailable';
    const token=await portableGmailAccessToken(config);
    // A snapshot can predate dispatch. Only a restore hold falls back to the
    // original send window in that case, without recording an estimated send time.
    const sentTime=target.dispatchStartedAt!==null?new Date(target.dispatchStartedAt).toISOString():
      target.issue==='restore_requires_reconciliation'
        ?{earliest:target.scheduledFor,latest:target.scheduledFor+gmailSendGraceMs}:undefined;
    const receipt=await findSentGmail(token,portableGmailMessageId(key),undefined,sentTime);
    if(!receipt)return 'unconfirmed';
    return await recordGmailReconciliation(db,key,config.owner,receipt)?'confirmed':'unavailable';
  }finally{await closePortableDb();}
}
