import {notFound} from 'next/navigation';
import {z} from 'zod';
import {PublicLeadForm} from '../app/forms/public-lead-form';
import {enabledLeadForm} from '../db/postgres/lead-form-store';
import {leadFormEmbedOrigin} from '../lib/lead-form-embedding';
import {portableMode} from './portable-config.mjs';
import {portableDb} from './portable-db';

export const metadata={title:'Contact · Harbor',robots:{index:false,follow:false},referrer:'no-referrer'};

export default async function PortablePublicLeadForm({params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  if(!z.string().guid("Invalid uuid").safeParse(id).success)notFound();
  const form=await enabledLeadForm(portableDb(),id);
  if(!form)notFound();
  const {title,description,thankYou}=form.definition;
  const approvedEmbedOrigin=leadFormEmbedOrigin(form.definition.embedOrigin,portableMode(process.env));
  return <PublicLeadForm form={{id,revision:form.revision,definition:{title,description,thankYou}}} approvedEmbedOrigin={approvedEmbedOrigin} newTabPrivacy/>;
}
