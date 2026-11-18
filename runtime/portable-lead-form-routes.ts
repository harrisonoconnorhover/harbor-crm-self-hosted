import {createHash} from 'node:crypto';
import {z} from 'zod';
import {enabledLeadForm,listLeadForms,manageLeadForm,readLeadInquiries,submitLeadInquiry} from '../db/postgres/lead-form-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {leadFormAutomationNote,portableInquiryFilter,portableInquirySearch,portableLeadFormAction} from '../lib/portable-lead-forms';
import {leadFormEmbedOrigin} from '../lib/lead-form-embedding';
import {portableMode} from './portable-config.mjs';
import {leadFormSubmit,SupersededLeadFormError,supersededLeadFormCode} from '../lib/lead-forms';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {portableRateLimit} from './portable-rate-limit';
import {currentPortableApiToken} from '../db/postgres/portable-api-token-store';
import {digest} from '../lib/api-access';
import {leadWebhookFingerprint,receiveLeadWebhook} from '../lib/lead-webhook';
import {portableWorkspaceGuest} from './portable-identity';

const uuid=z.string().guid("Invalid uuid");
const query=z.object({formId:uuid.optional(),afterAt:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  afterId:uuid.optional(),filter:portableInquiryFilter.optional(),followUp:z.literal('open').optional(),
  inquiries:z.literal('workspace').optional(),inquirySearch:portableInquirySearch}).strict()
  .refine(input=>(input.afterAt===undefined)===(input.afterId===undefined)&&
    (input.formId?input.followUp===undefined&&input.inquiries===undefined:input.inquiries?input.followUp===undefined:
      input.afterAt===undefined&&input.filter===undefined));
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store','referrer-policy':'no-referrer'}});

function failure(error:unknown,message:string){
  if(error instanceof ApiError)return json({error:error.message},error.status);
  if(error instanceof SyntaxError||error instanceof z.ZodError)return json({error:message},400);
  console.error('Portable lead form request failed.');
  return json({error:'Could not confirm this request. Try again with the same request ID.'},503);
}

export async function manageForms(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method!=='POST'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid form query.'},400);
      const input=query.parse(Object.fromEntries(params));
      if(input.formId||input.inquiries)return json(await readLeadInquiries(db,user.userId,input.formId,
        input.afterAt!==undefined&&input.afterId?{at:input.afterAt,id:input.afterId}:undefined,
        input.filter??(input.inquiries?'open':'all'),input.inquirySearch));
      if(params.has('inquirySearch'))return json({error:'Invalid form query.'},400);
      const forms=await listLeadForms(db,user.userId);
      return json({forms:input.followUp==='open'?forms.filter(form=>form.hasOpenInquiries):forms});
    }
    if(params.size)return json({error:'Invalid form settings query.'},400);
    const text=await readBoundedRequestText(request,32*1024);
    if(text===null)return json({error:'Form settings are too large.'},413);
    const input=portableLeadFormAction.parse(JSON.parse(text));
    if(input.action==='save'&&input.definition.queueWorkflows&&!leadFormAutomationNote(input.definition))
      return json({error:'Enable automatic Contact capture and enter the internal Note text.'},400);
    if(input.action==='save'&&input.definition.embedOrigin!==undefined){
      const value=input.definition.embedOrigin;
      const origin=leadFormEmbedOrigin(value,portableMode(process.env));
      if(value&&!origin)return json({error:'Enter the website’s HTTPS origin, without a page path.'},400);
      input.definition.embedOrigin=origin;
    }
    return json(await manageLeadForm(db,user.userId,input));
  }catch(error){return failure(error,'Check the form settings.');}
}

export async function publicSubmit(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(request.headers.get('origin')!==new URL(request.url).origin)
      return json({error:'Submit this inquiry from the form page.'},403);
    const {id}=await context.params;
    if(!uuid.safeParse(id).success)return json({error:'Form unavailable.'},404);
    const text=await readBoundedRequestText(request,32*1024);
    if(text===null)return json({error:'This inquiry is too long. Shorten your message.'},413);
    const input=leadFormSubmit.parse(JSON.parse(text));
    const db=portableDb(),form=await enabledLeadForm(db,id);
    if(!form)return json({error:'Form unavailable.'},404);
    const denied=await portableRateLimit('public_form',id);
    if(denied)return denied;
    if(!input.website){
      const fingerprint=createHash('sha256').update(JSON.stringify([id,input.revision,input.payload])).digest('hex');
      await submitLeadInquiry(db,id,form.workspaceId,input,fingerprint);
    }
    return json({accepted:true});
  }catch(error){
    if(error instanceof SupersededLeadFormError)return json({error:error.message,code:supersededLeadFormCode},error.status);
    return failure(error,'Check your name, email address and message length.');
  }
}

export function webhookSubmit(request:Request,{params}:{params:Promise<{id:string}>}){
  return receiveLeadWebhook(request,params,async request=>{
    const match=/^Bearer (harbor_[a-f0-9]{64})$/i.exec(request.headers.get('authorization')??'');
    if(!match)throw new ApiError(401,'Send a Harbor access token in Authorization: Bearer <token>.');
    const token=await currentPortableApiToken(portableDb(),await digest(match[1]));
    if(!token)throw new ApiError(401,'Access token is invalid, expired, or revoked.');
    if(portableWorkspaceGuest(token.email.toLowerCase())||!token.scopes.includes('inquiries:write'))
      throw new ApiError(403,'This token does not allow inbound inquiries.');
    return token;
  },async(token,id,input)=>{
    const db=portableDb(),form=await enabledLeadForm(db,id);
    if(!form||form.workspaceId!==token.workspaceId||form.definition.captureContacts!==false)
      throw new ApiError(404,'Form unavailable.');
    const limited=await portableRateLimit('public_form',id);
    if(limited)return limited;
    await submitLeadInquiry(db,id,token.workspaceId,{...input,revision:form.revision,website:''},
      await leadWebhookFingerprint(id,input),token.id);
  });
}
