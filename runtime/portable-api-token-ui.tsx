'use client';

import {useState,type FormEvent} from 'react';
import {canManagePrimaryLinks} from '../lib/portable-api-tokens';
import type {ApiTokenInfo} from '../lib/api-access';
import type {readPortableApiTokens} from '../db/postgres/portable-api-token-store';
import type {WebhookSettingsPage} from '../db/postgres/webhook-management-store';
import {PortableWebhooks} from './portable-webhook-ui';
import {PortableSettingsLayout} from './portable-settings-layout';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';
import './portable-settings.css';

type Page=Awaited<ReturnType<typeof readPortableApiTokens>>;
const path='/api/api-tokens';
const kinds=[['contacts','Contacts'],['companies','Companies'],['deals','Deals'],['tasks','Tasks'],['leads','Leads'],['tickets','Tickets']] as const;

async function tokenRequest<T>(query='',body?:unknown){
  const response=await fetch(path+query,body?{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
  }:{cache:'no-store'});
  if(!response.ok){
    const result=await response.json().catch(()=>null) as {error?:string}|null;
    throw Error(result?.error??'Could not manage API tokens.');
  }
  return await response.json() as T;
}

function scopeLabel(scope:string){
  if(scope==='associations:primary')return 'Manage primary relationships';
  if(scope==='associations:write')return 'Manage labeled relationships';
  if(scope==='associations:read')return 'Read record relationships';
  if(scope.startsWith('directory:oidc:'))return 'Manage OpenID Connect employees';
  if(scope.startsWith('directory:saml:'))return 'Manage company SSO employees';
  const entra='directory:entra:';
  if(scope.startsWith(entra))return 'Manage Microsoft Entra employees ('+scope.slice(entra.length)+')';
  if(scope==='directory:manage')return 'Legacy Microsoft directory token (replace to resume provisioning)';
  return scope;
}

export function PortableApiTokens({email,initial,directoryEnabled,samlDirectoryEnabled,oidcDirectoryEnabled,webhooks}:{email:string;initial:Page;directoryEnabled:boolean;samlDirectoryEnabled:boolean;oidcDirectoryEnabled:boolean;webhooks:WebhookSettingsPage}){
  const [page,setPage]=useState(initial);
  const [secret,setSecret]=useState('');
  const [busy,setBusy]=useState(false);
  const [paged,setPaged]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [purpose,setPurpose]=useState('records');
  const [permissions,setPermissions]=useState<Record<string,string>>({});

  const directory=purpose==='directory'||purpose==='saml_directory'||purpose==='oidc_directory';

  async function run(action:()=>Promise<void>){
    setBusy(true);setError('');setNotice('');
    try{await action();}
    catch(error){setError((error as Error).message);}
    finally{setBusy(false);}
  }

  async function load(cursor?:NonNullable<Page['next']>){
    const query=cursor?'?'+new URLSearchParams({afterAt:String(cursor.afterAt),afterId:cursor.afterId}):'';
    setPage(await tokenRequest<Page>(query));
    setPaged(!!cursor);
  }

  function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=event.currentTarget,fields=new FormData(form);
    void run(async()=>{
      const value=await tokenRequest<{token:string}>('',{
        name:fields.get('name'),days:Number(fields.get('days')),
        ...(directory?{purpose}:purpose==='records'?{permissions,associationAccess:fields.get('associationAccess')||undefined}:{objects:['inquiries'],permission:'read_write'}),
      });
      setSecret(value.token);setNotice('Token created.');
      form.reset();setPermissions({});setPurpose('records');
      await load();
    });
  }

  function revoke(id:string){
    void run(async()=>{
      await tokenRequest('',{action:'revoke',id});
      setSecret('');
      setNotice('Token revoked.');
      await load();
    });
  }

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="api-access"/>
    <PortableSettingsLayout active="api-access">
    <section className="portable-settings-content portable-api-settings" aria-labelledby="portable-api-access">
      <header className="portable-settings-heading">
        <h1 id="portable-api-access">API access</h1>
        <p>Choose the access each integration needs in your workspace.</p>
      </header>
      {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
      {secret&&<section className="portable-token-secret" aria-label="New token">
        <label>Copy this token now. Harbor shows it only once.
          <input readOnly value={secret} onFocus={event=>event.target.select()}/>
        </label>
        <button type="button" onClick={()=>setSecret('')}>Hide token</button>
      </section>}
      <section aria-labelledby="portable-token-create">
        <h2 id="portable-token-create">Create a token</h2>
        <form className="portable-token-form" onSubmit={create}>
          <div className="portable-token-fields">
            <label>Token name<input name="name" required maxLength={80} disabled={busy||!!secret}/></label>
            <label>Expires in<select name="days" disabled={busy||!!secret}>
              <option value="30">30 days</option><option value="90">90 days</option><option value="365">365 days</option>
            </select></label>
          </div>
          <label>Token purpose<select value={purpose} onChange={event=>setPurpose(event.target.value)} disabled={busy||!!secret}>
            <option value="records">CRM records</option><option value="inquiries">Submit form inquiries</option>
            {directoryEnabled&&<option value="directory">Manage Microsoft Entra employees</option>}
            {oidcDirectoryEnabled&&<option value="oidc_directory">Manage OpenID Connect employees</option>}
            {samlDirectoryEnabled&&<option value="saml_directory">Manage company SSO employees</option>}
          </select></label>
          {directory?<p>Allows the selected directory to grant and revoke employee access and sync membership in teams you explicitly link.</p>:
            purpose==='inquiries'?<p>Submit to enabled inbox-only forms in this workspace.</p>:<fieldset disabled={busy||!!secret}><legend>Record permissions</legend>
            <p>Track removals to read the IDs and dates of archived or permanently deleted records.</p>
            {kinds.map(([kind,label])=><label key={kind}>{label} access
              <select name={kind} value={permissions[kind]??''} onChange={event=>{
                const level=event.target.value;
                setPermissions(current=>{
                  const next={...current};
                  if(level)next[kind]=level;else delete next[kind];
                  return next;
                });
              }}>
                <option value="">No access</option><option value="read">Read only</option>
                <option value="read_history">Read records and track removals</option>
                <option value="read_write">Read, create and edit</option>
                <option value="read_write_history">Read, create, edit and track removals</option>
                <option value="read_write_archive">Read, create, edit and archive</option>
              </select>
            </label>)}
            {['contacts','companies','deals'].some(kind=>permissions[kind])&&
              <label>Record relationships<select name="associationAccess" defaultValue="">
                <option value="">No access</option><option value="read">Read relationships</option>
                {['contacts','companies','deals'].some(kind=>permissions[kind]?.startsWith('read_write'))&&
                  <option value="read_write">Read and manage labeled links</option>}
                {canManagePrimaryLinks(permissions)&&<><option value="primary">Read and manage primary links</option>
                  <option value="all">Read and manage primary and labeled links</option></>}
              </select></label>}
          </fieldset>}
          <button type="submit" disabled={busy||!!secret||(purpose==='records'&&!Object.keys(permissions).length)}>{directory?'Create directory token':purpose==='inquiries'?'Create inquiry token':'Create record token'}</button>
        </form>
      </section>
      <section aria-labelledby="portable-workspace-tokens">
        <h2 id="portable-workspace-tokens">Workspace tokens</h2>
        {page.tokens.length?<ul>{page.tokens.map((token:ApiTokenInfo)=><li className="portable-token-row" key={token.id}>
          <div>
            <strong>{token.name}</strong>
            <p><code>{token.prefix}…</code> · {token.scopes.map(scopeLabel).join(', ')}</p>
          </div>
          <span className="portable-token-state">{token.revokedAt?'Revoked':<>Expires <time
            dateTime={token.expiresAt.slice(0,10)}>{token.expiresAt.slice(0,10)}</time></>}</span>
          {kinds.some(([kind])=>token.scopes.includes(kind+':read'))&&
            <a href={'/?view=record-access&token='+token.id}>View record access</a>}
          {!token.revokedAt&&<button type="button" disabled={busy} onClick={()=>revoke(token.id)}>Revoke {token.name}</button>}
        </li>)}</ul>:<p className="portable-settings-empty">{paged?'No older workspace tokens.':'No workspace tokens yet.'}</p>}
        {(paged||page.next)&&<nav aria-label="Token pages">
          {paged&&<button type="button" disabled={busy} onClick={()=>void run(()=>load())}>Newest tokens</button>}
          {page.next&&<button type="button" disabled={busy} onClick={()=>void run(()=>load(page.next??undefined))}>Older tokens</button>}
        </nav>}
      </section>
      <PortableWebhooks initial={webhooks}/>
      <section aria-label="API request example">
        <details>
          <summary>API request example</summary>
          <p>Use <code>Authorization: Bearer &lt;token&gt;</code> with <code>GET /api/v1/records/contacts</code>.
            The same path supports <code>companies</code>, <code>deals</code>, <code>tasks</code>, <code>leads</code> and <code>tickets</code>. With write access, POST a new UUID and properties to the collection. To edit a record, PATCH its URL with the ETag from GET in <code>If-Match</code>. Archive access enables DELETE with that same version check.</p>
          <p>For an incremental sync, list active records with <code>updatedSince</code> and <code>updatedBefore</code>.
            To find records moved to the Recycle Bin, use <code>archived=true</code> with <code>archivedSince</code> and <code>archivedBefore</code>.
            Supply UTC times and pass both fields from <code>next</code> to fetch another page in the same window.</p>
          <p>To sync linked contacts for several companies, POST their IDs to <code>/api/v1/associations/companies/contacts/batch/read</code>. Each company has its own next page. The key needs read access to both objects and their relationships.</p>
          <p>To map fields, read <code>GET /api/v1/properties/contacts</code>. Each record type lists its standard fields and any custom fields this token can read.</p>
          <p>To find a contact by email, POST <code>{'{"idProperty":"email","inputs":[{"id":"mira@example.test"}]}'}</code> to <code>/api/v1/records/contacts/batch/read</code>. Companies support the same lookup by domain. To match an external CRM ID on Contacts, Companies or Deals, use <code>custom:&lt;field UUID&gt;</code> as the ID property for a readable single-line text field.</p>
          <p>To create several records, POST up to 50 new UUIDs and their properties in <code>inputs</code> to <code>/api/v1/records/contacts/batch/create</code>. Save those IDs before sending so you can check individual results after a retry.</p>
          <p>To edit several records, POST up to 50 IDs, ETags and property changes in <code>inputs</code> to <code>/api/v1/records/contacts/batch/update</code>. Check the result for each record.</p>
          <p>To archive a batch, POST up to 50 reviewed ID and ETag pairs in <code>inputs</code> to <code>/api/v1/records/contacts/batch/archive</code>.
            To check the outcome, POST the IDs to <code>/api/v1/records/contacts/batch/read?archived=true</code> for their archive times.</p>
        </details>
      </section>
    </section>
    </PortableSettingsLayout>
  </main>;
}
