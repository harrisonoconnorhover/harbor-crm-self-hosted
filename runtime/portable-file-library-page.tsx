import {WorkspaceNumber} from './portable-workspace-format';
import {portablePageHasBody} from './portable-page-body';
import {withPortableNavigation} from './portable-navigation';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {portableLoginConfig} from './portable-login-config';
import {notFound} from 'next/navigation';
import {z} from 'zod';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {readPortableFileLibrary,type PortableFileSort} from '../db/postgres/portable-file-library-store';
import {portableRecordSearch,recordSearchLimit} from '../lib/portable-records';
import {portableDb} from './portable-db';
import {PortableFileFolders,PortableFileMove} from './portable-file-folder-ui';
import {portableWorkspaceGuest} from './portable-identity';
import {objectStorageConfigured} from './portable-object-storage';
import {PortableRecordPicker} from './portable-record-picker';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';

const id=z.string().guid("Invalid uuid");
const legacyCursor=z.tuple([id,id]);
const sortedCursor=z.tuple([z.enum(['name','newest']),id,id,id]);
const query=z.object({view:z.literal('files'),workspaceId:id.optional(),
  search:z.preprocess(value=>typeof value==='string'?value.trim()||undefined:value,portableRecordSearch.optional()),
  folder:z.union([z.literal('root'),id]).optional(),
  contactId:z.preprocess(value=>value===''?undefined:value,id.transform(value=>value.toLowerCase()).optional()),
  sort:z.enum(['default','name','newest']).default('default'),
  after:z.string().max(117).optional()}).strict();
type LibraryLocation={workspaceId?:string;search?:string;folder?:string;sort?:PortableFileSort;contactId?:string;after?:string|null};
const libraryPath=({workspaceId,search,folder,sort='default',contactId,after}:LibraryLocation={})=>{
  const params=new URLSearchParams({view:'files'});
  if(workspaceId)params.set('workspaceId',workspaceId);
  if(search)params.set('search',search);
  if(folder)params.set('folder',folder);
  if(sort!=='default')params.set('sort',sort);
  if(contactId)params.set('contactId',contactId);
  if(after)params.set('after',after);
  return '/?'+params;
};

function parseCursor(after:string,sort:PortableFileSort){
  const parts=after.split(':');
  if(sort==='default'){
    const parsed=legacyCursor.safeParse(parts);
    return parsed.success?{contactId:parsed.data[0],fileId:parsed.data[1]}:null;
  }
  const parsed=sortedCursor.safeParse(parts);
  if(!parsed.success||parsed.data[0]!==sort)return null;
  const [,contactId,fileId,versionId]=parsed.data;
  return {contactId,fileId,versionId};
}

export async function PortableFileLibraryPage({input}:{input:unknown}){
  const parsed=query.safeParse(input);
  if(!parsed.success)notFound();
  const {workspaceId,search,folder,sort,contactId,after}=parsed.data;
  const selection={workspaceId,search,folder,sort,contactId};
  const position=after===undefined?undefined:parseCursor(after,sort);
  if(position===null||(contactId&&position&&position.contactId.toLowerCase()!==contactId))notFound();
  const user=await requireChatGPTUser(libraryPath({...selection,after}));
  const db=portableDb();
  if(!objectStorageConfigured())notFound();
  if(portableWorkspaceGuest(user.email)&&(!workspaceId||!await guestWorkspaceAllowed(db,user.userId,workspaceId,portableLoginConfig().allowedEmails)))notFound();
  const scope=workspaceId?{workspaceId}:undefined;
  const library=await readPortableFileLibrary(db,user,{workspaceId,search,after:position,folderId:folder,sort,contactId},await portablePageHasBody());
  if(!library)notFound();
  const {files,next,folder:currentFolder,path}=library;
  return withPortableNavigation(user.email,<main className="portable-contacts">
    <PortableCrmHeader email={user.email} page="files" workspaceId={workspaceId} currentHref={libraryPath(scope)} filesEnabled/>
    <section aria-labelledby="portable-files-title">
      <h1 id="portable-files-title" tabIndex={-1}>Files</h1>
      {workspaceId?<p>Search attachments on contacts you can view in this workspace.</p>:<p>Find current files attached to active Contacts. Open the Contact to upload, replace, or view its file versions.</p>}
      {!workspaceId&&<><nav aria-label="File folders">
        <a href={libraryPath({...selection,folder:undefined})} aria-current={!folder?'page':undefined}>All files</a>
        <a href={libraryPath({...selection,folder:'root'})} aria-current={folder==='root'?'page':undefined}>Root</a>
        {path.map(crumb=>crumb.id===currentFolder?.id?<span key={crumb.id} aria-current="page">{crumb.name}</span>:
          <a key={crumb.id} href={libraryPath({...selection,folder:crumb.id})}>{crumb.name}</a>)}
      </nav>
      {currentFolder&&<h2>{currentFolder.name}</h2>}
      <PortableFileFolders folder={currentFolder} search={search} sort={sort} contactId={contactId}/></>}
      <form method="get" action="/">
        <input type="hidden" name="view" value="files"/>
        {workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
        {folder&&<input type="hidden" name="folder" value={folder}/>}
        <PortableRecordPicker key={contactId??'all'} kind="contacts" workspaceId={workspaceId} field="contactId" label="Contact"
          value={library.contact} emptyLabel="All Contacts"/>
        <label>Search files or Contacts<input name="search" type="search" defaultValue={search??''} maxLength={recordSearchLimit}/></label>
        <label>Sort by <select name="sort" defaultValue={sort}>
          <option value="default">Default order</option>
          <option value="name">File name (A–Z)</option>
          <option value="newest">Newest upload</option>
        </select></label>
        <button type="submit">Apply</button>
        {search&&<a href={libraryPath({...selection,search:undefined})}>Clear search</a>}
      </form>
      {files.length?<div className="portable-contacts-table"><table><thead><tr><th scope="col">File</th><th scope="col">Contact</th><th scope="col">Size</th>{!workspaceId&&<><th scope="col">Folder</th><th scope="col">Actions</th></>}</tr></thead>
        <tbody>{files.map(file=><tr key={file.contactId+':'+file.fileId}>
          <td><a href={'/api/record-attachments?'+new URLSearchParams({
            recordId:file.contactId,fileId:file.fileId,versionId:file.versionId,...scope})}>{file.name}</a></td>
          <td><a href={'/?'+new URLSearchParams({contact:file.contactId,...scope})}>{file.contactName||'Untitled Contact'}</a></td>
          <td><WorkspaceNumber value={file.size}>{file.size.toLocaleString('en-US')}</WorkspaceNumber> bytes</td>
          {!workspaceId&&<><td>{file.folderId?<a href={libraryPath({...selection,folder:file.folderId})}>{file.folderName||'Open folder'}</a>:
            <a href={libraryPath({...selection,folder:'root'})}>Root</a>}</td>
          <td><PortableFileMove name={file.name} filtered={!!folder} file={{contactId:file.contactId,fileId:file.fileId,versionId:file.versionId,
            folderId:file.folderId,locationRevision:file.locationRevision}}/></td></>}
        </tr>)}</tbody>
      </table></div>:<p>{search||contactId?'No matching files on this page.':'No files on this page.'}</p>}
      <nav aria-label="File pages">
        {after&&<a href={libraryPath(selection)}>First page</a>}
        {next&&<a href={libraryPath({...selection,after:next})}>Next page</a>}
      </nav>
    </section>
  </main>,{actorId:user.userId,workspaceId});
}
