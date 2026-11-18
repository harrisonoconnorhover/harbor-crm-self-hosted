import {z} from 'zod';
import {visibleContactScope} from '../db/postgres/contact-store';
import {sharedRecordWriteScope} from '../lib/portable-workspace-access';
import {cancelPortableJob,contactJobHistory,enqueueNote,retryInternalJob,reviewPortableJob} from '../db/postgres/job-store';
import {enqueueGmail} from '../db/postgres/scheduled-gmail-store';
import {suppressedAddress} from '../lib/email/suppression';
import {portableGmailOwner} from './portable-gmail-config';
import {attachmentBytes} from '../lib/activity-attachments';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const uuid=z.string().guid("Invalid uuid");
const epoch=z.number().int().min(0).max(8640000000000000);
const query=z.object({recordId:uuid,workspaceId:uuid.optional(),grantId:uuid.optional(),afterAt:z.coerce.number().pipe(epoch).optional(),afterId:uuid.optional()}).strict()
  .refine(input=>(input.afterAt===undefined)===(input.afterId===undefined));
const note=z.object({id:uuid,body:z.string().trim().min(1).max(2_000),scheduledFor:epoch}).strict();
const email=z.object({kind:z.literal('gmail'),id:uuid,recipient:suppressedAddress,subject:z.string().trim().min(1).max(200),
  body:z.string().trim().min(1).max(8000),scheduledFor:epoch}).strict();
const cancel=z.object({action:z.enum(['cancelGmail','cancelNote','cancelTask']),id:uuid}).strict();
const retry=z.object({action:z.enum(['retryNote','retryTask']),id:uuid}).strict();
const review=z.object({action:z.enum(['reviewGmail','reviewExternal']),id:uuid}).strict();
const reviewFailed=z.object({action:z.enum(['reviewFailed','reviewSuppressedGmail']),id:uuid,attempts:z.number().int().nonnegative()}).strict();
const jobRequest=z.union([note,email,cancel,retry,review,reviewFailed]);
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

const contactMissing=()=>json({error:'Contact not found.'},404);
const accessChanged=()=>json({error:'You no longer have access to schedule notes here. Refresh before trying again.'},403);

async function route(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    const input=query.safeParse(Object.fromEntries(params));
    if(!input.success||params.size!==new Set(params.keys()).size)return json({error:'Invalid contact job query.'},400);
    const {recordId,workspaceId,grantId,afterAt,afterId}=input.data;
    const writing=request.method==='POST';
    if(!writing&&grantId)return json({error:'Invalid contact job query.'},400);
    let shared;
    if(writing&&(workspaceId||grantId)){
      const parsed=sharedRecordWriteScope.safeParse({workspaceId,grantId});
      if(!parsed.success)return accessChanged();
      shared=parsed.data;
    }
    const db=portableDb(),scope=await visibleContactScope(db,user.userId,recordId,workspaceId,'scheduledNotes');
    if(!writing)return scope?json(await contactJobHistory(db,scope,
      afterAt!==undefined&&afterId?{at:afterAt,id:afterId}:undefined,!!workspaceId)):contactMissing();
    if(!scope&&shared)return contactMissing();
    let data:unknown;
    try{
      const body=await attachmentBytes(request,16_384);
      data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));
    }catch{return scope?json({error:'Enter a note and a valid schedule.'},400):contactMissing();}
    const parsed=jobRequest.safeParse(data);
    if(!parsed.success)return scope?json({error:'Enter valid job details and a schedule.'},400):contactMissing();
    const job=parsed.data;
    if('action' in job&&(job.action==='reviewGmail'||job.action==='reviewExternal'||job.action==='reviewFailed'||job.action==='reviewSuppressedGmail')){
      const gmail=job.action==='reviewGmail';
      if(shared)return json({error:'Only the workspace owner can review this job.'},403);
      const result=await reviewPortableJob(db,recordId,user.userId,job);
      if(result==='missing')return json({error:gmail?'Email not found.':'Job not found.'},404);
      if(result==='conflict')return json({error:gmail?'This email does not have an uncertain delivery to review.':
        job.action==='reviewExternal'?'This job does not have an uncertain outcome to review.':
        job.action==='reviewSuppressedGmail'?'This email does not have a matching suppressed attempt to review.':
          'This failure changed. Refresh the queue before reviewing it.'},409);
      return json({id:job.id,result});
    }
    if(!scope)return contactMissing();
    if('action' in job){
      if(job.action==='retryNote'||job.action==='retryTask'){
        const kind=job.action==='retryTask'?'task':'note';
        if(shared)return json({error:'Only the workspace owner can retry this job.'},403);
        const result=await retryInternalJob(db,scope,user.userId,job.id,kind);
        if(result==='missing')return json({error:'Job not found.'},404);
        if(result==='conflict')return json({error:'This job is no longer eligible for a retry.'},409);
        if(result==='full')return json({error:'This workspace already has 100 pending jobs.'},429);
        return json({id:job.id,result},202);
      }
      const kind=job.action==='cancelGmail'?'gmail':job.action==='cancelTask'?'task':'note';
      const label=kind==='gmail'?'Email':kind==='task'?'Task':'Note';
      if(shared)return json({error:'Only the workspace owner can cancel this '+label.toLowerCase()+'.'},403);
      const result=await cancelPortableJob(db,scope,user.userId,job.id,kind);
      if(result==='missing')return json({error:label+' not found.'},404);
      if(result==='conflict')return json({error:'This '+label.toLowerCase()+' is past the cancellation point.'},409);
      return json({cancelled:true});
    }
    const gmail='kind' in job;
    const sender=gmail?portableGmailOwner():undefined;
    if(gmail&&(shared||!sender||sender!==user.email.toLowerCase()))return json({error:'Scheduled Gmail is unavailable for this account.'},403);
    const result=gmail?await enqueueGmail(db,scope,user.userId,sender!,job):await enqueueNote(db,scope,user.userId,job,shared);
    if(result==='recipient')return json({error:'Add a valid email address to this contact.'},400);
    if(result==='recipient_changed')return json({error:'Contact email changed. Reload before scheduling.'},409);
    if(result==='content')return json({error:'Check the subject and plain-text message.'},400);
    if(result==='suppressed')return json({error:'This address is on the workspace do-not-email list.'},409);
    if(result==='access')return accessChanged();
    if(result==='missing')return json({error:'Contact not found.'},404);
    if(result==='date')return json({error:gmail?'Choose a current or future time within 90 days.':'Choose a time within the next 90 days.'},400);
    if(result==='full')return json({error:'This workspace already has 100 pending jobs.'},429);
    if(result==='conflict')return json({error:'This request ID was already used for a different job.'},409);
    return json({id:job.id},202);
  }catch{
    console.error('Portable contact jobs request failed.');
    return json({error:'Could not confirm this request. Retry with the same request ID.'},500);
  }
}
export {route as GET,route as POST};
