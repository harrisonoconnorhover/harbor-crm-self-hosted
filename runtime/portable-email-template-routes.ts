import {z} from 'zod';
import {
  deletePortableEmailTemplate,listPortableEmailTemplates,readPortableEmailTemplate,readPortableEmailTemplatePreview,savePortableEmailTemplate,
} from '../db/postgres/portable-email-template-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableTemplateDelete,portableTemplateQuery,portableTemplateSave,renderPortableTemplate} from '../lib/portable-email-templates';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const missing=()=>json({error:'Template not found in your workspace.'},404);
const stale=()=>json({error:'The template changed. Refresh the library and try again.'},409);

async function route(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    if(user.guest)return json({error:'Only the workspace owner can use email templates.'},403);
    const db=portableDb(),params=new URL(request.url).searchParams;
    if(request.method==='GET'||request.method==='HEAD'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid template query.'},400);
      const input=portableTemplateQuery.parse(Object.fromEntries(params));
      if('id' in input&&input.contactId){
        const preview=await readPortableEmailTemplatePreview(db,user.userId,input.id,input.contactId);
        if(!preview)return json({error:'Template or Contact not found in your workspace.'},404);
        const rendered=renderPortableTemplate(preview.template,preview.contact,user.displayName);
        if(!rendered)return json({error:'The personalized subject or message is empty, too long or invalid.'},400);
        const {subject,body,missing}=rendered;
        return json({template:{...preview.template,subject,body},missing});
      }
      if('id' in input){
        const template=await readPortableEmailTemplate(db,user.userId,input.id);
        return template?json({template}):missing();
      }
      return json(await listPortableEmailTemplates(db,user.userId,input.search,input.after));
    }
    if(params.size)return json({error:'Invalid template request.'},400);
    const text=await readBoundedRequestText(request,52_000);
    if(text===null)return json({error:'Template request is too large.'},413);
    const body=JSON.parse(text);
    if(request.method==='DELETE'){
      const result=await deletePortableEmailTemplate(db,user.userId,portableTemplateDelete.parse(body));
      if(result==='missing')return missing();
      if(result==='stale')return stale();
      return json({ok:true});
    }
    const result=await savePortableEmailTemplate(db,user.userId,portableTemplateSave.parse(body));
    if(!('template' in result))return result.status==='missing'?missing():stale();
    return json({template:result.template},result.status==='created'?201:200);
  }catch(error){
    if(error instanceof z.ZodError)return json({error:error.issues[0]?.message??'Check the template fields.'},400);
    if(error instanceof SyntaxError)return json({error:'Send valid JSON.'},400);
    return json({error:'Could not manage email templates. Try again.'},503);
  }
}
export {route as GET,route as PUT,route as DELETE};
