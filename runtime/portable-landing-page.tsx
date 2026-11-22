import './portable-landing.css';
import {notFound} from 'next/navigation';
import Link from 'next/link';
import {z} from 'zod';
import {landingListPath,landingStatuses} from '../lib/portable-landing';
import {landingList,ownerLanding} from '../db/postgres/landing-page-store';
import {readOwnedWorkspaceId} from '../db/postgres/private-workspace-store';
import {listLeadForms} from '../db/postgres/lead-form-store';
import {PortableCrmHeader} from './portable-crm-header';
import {PortableLandingEditor} from './portable-landing-ui';
import {publicLandingAddress,workspaceLandingDomains} from './portable-landing-address';
import {portableDb} from './portable-db';

const query=z.object({view:z.literal('landing-pages'),q:z.string().trim().max(120).refine(value=>!value.includes('\0')).optional(),status:z.enum(['','draft','published','changed']).optional(),edit:z.union([z.literal('new'),z.string().guid()]).optional(),after:z.string().guid().optional(),copy:z.string().guid().optional()})
  .strict().refine(q=>!q.copy||q.edit==='new');
export async function LandingPageManager({user,input}:{user:{email:string;userId:string};input:Record<string,string|undefined>}){
  const parsed=query.safeParse(input);
  if(!parsed.success)notFound();
  const db=portableDb(),{edit,after,copy}=parsed.data;
  const {q,status}=parsed.data, path=landingListPath({q,status,after});
  let content;
  if(edit){
    const sourceId=edit==='new'?copy:edit;
    const source=sourceId?await ownerLanding(db,user.userId,sourceId):undefined;
    if(sourceId&&!source)notFound();
    const page=copy?undefined:source;
    const copiedDraft=copy&&source?{...source.draft,slug:'',redirectFrom:undefined}:undefined;
    const workspace=source?.workspaceId??await readOwnedWorkspaceId(db,user.userId);
    const forms=(await listLeadForms(db,user.userId)).map(f=>({id:f.id,title:f.definition.title,enabled:f.enabled,embedOrigin:f.definition.embedOrigin??undefined}));
    content=<PortableLandingEditor key={copy?'copy-'+copy:edit} id={page?.id??crypto.randomUUID()} page={page} copiedDraft={copiedDraft} listPath={path} initialForms={forms} domains={workspaceLandingDomains(workspace)}
      origin={process.env.HARBOR_LOGIN_ORIGIN!} initialUrl={page?publicLandingAddress(page):null}/>;
  }else{
    const {items,next}=await landingList(db,user.userId,{q,status,after});
    content=<section className="landing-manager"><h1>Landing pages</h1><Link prefetch={false} href={path+'&edit=new'}>Create landing page</Link>
      <form key={path} method="get" action="/" aria-label="Filter landing pages">
        <input type="hidden" name="view" value="landing-pages"/>
        <label>Search by title or address<input name="q" type="search" maxLength={120} defaultValue={q}/></label>
        <label>Publication status<select name="status" defaultValue={status??''}><option value="">All statuses</option>
          {Object.entries(landingStatuses).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <button type="submit">Apply</button>{(q||status)&&<Link prefetch={false} href={landingListPath({})}>Clear filters</Link>}
      </form>
      {items.length?<table><thead><tr><th>Page</th><th>Status</th><th>Actions</th></tr></thead><tbody>{items.map(page=>{
        const live=publicLandingAddress(page);
        return <tr key={page.id}><td><Link prefetch={false} href={path+'&edit='+page.id}>{page.title}</Link>
          <small>/{page.slug}</small></td>
          <td>{landingStatuses[!live?'draft':page.publishedRevision===page.draftRevision?'published':'changed']}
            {live&&<small><a href={live} target="_blank" rel="noreferrer" aria-label={'View live page '+page.publishedSlug}>{page.publishedSlug===page.slug?'View live page':'Live /'+page.publishedSlug}</a></small>}</td>
          <td><Link prefetch={false} href={path+'&edit=new&copy='+page.id} aria-label={'Duplicate draft of '+page.title}>Duplicate draft</Link></td></tr>;
      })}</tbody></table>:<p>{q||status?'No landing pages match these filters.':'No landing pages on this page.'}</p>}
      <nav aria-label="Landing page results">
        {after&&<Link prefetch={false} href={landingListPath({q,status})}>First page</Link>}
        {next&&<Link prefetch={false} href={landingListPath({q,status,after:next})}>More pages</Link>}
      </nav></section>;
  }
  return <main className="portable-contacts"><PortableCrmHeader email={user.email} page="landing-pages"/>{content}</main>;
}
