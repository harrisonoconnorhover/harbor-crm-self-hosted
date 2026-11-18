'use client';

import {useState,type FormEvent} from 'react';
import type {ApiTokenInfo} from '../lib/api-access';
import type {readPortableApiTokens} from '../db/postgres/portable-api-token-store';
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

export function PortableApiTokens({email,initial}:{email:string;initial:Page}){
  const [page,setPage]=useState(initial);
  const [secret,setSecret]=useState('');
  const [busy,setBusy]=useState(false);
  const [paged,setPaged]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [inquiryOnly,setInquiryOnly]=useState(false);

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
        name:fields.get('name'),objects:inquiryOnly?['inquiries']:fields.getAll('objects'),
        days:Number(fields.get('days')),permission:inquiryOnly?'read_write':'read',
      });
      setSecret(value.token);setNotice(inquiryOnly?'Inquiry token created.':'Read token created.');
      form.reset();
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
    <section className="portable-settings-content portable-api-settings" aria-labelledby="portable-api-access">
      <header className="portable-settings-heading">
        <h1 id="portable-api-access">API access</h1>
        <p>Create read-only CRM tokens or write-only inquiry tokens for integrations in your private workspace.</p>
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
          <label className="portable-token-check"><input type="checkbox" checked={inquiryOnly} disabled={busy||!!secret}
            onChange={event=>setInquiryOnly(event.target.checked)}/> Form inquiries only</label>
          {inquiryOnly?<p>Submit to enabled inbox-only forms in this workspace.</p>:<fieldset disabled={busy||!!secret}><legend>Read access</legend>
            {kinds.map(([kind,label])=><label className="portable-token-check" key={kind}><input type="checkbox" name="objects" value={kind}/>{label}</label>)}
          </fieldset>}
          <button type="submit" disabled={busy||!!secret}>{inquiryOnly?'Create inquiry token':'Create read token'}</button>
        </form>
      </section>
      <section aria-labelledby="portable-workspace-tokens">
        <h2 id="portable-workspace-tokens">Workspace tokens</h2>
        {page.tokens.length?<ul>{page.tokens.map((token:ApiTokenInfo)=><li className="portable-token-row" key={token.id}>
          <div>
            <strong>{token.name}</strong>
            <p><code>{token.prefix}…</code> · {token.scopes.join(', ')}</p>
          </div>
          <span className="portable-token-state">{token.revokedAt?'Revoked':<>Expires <time
            dateTime={token.expiresAt.slice(0,10)}>{token.expiresAt.slice(0,10)}</time></>}</span>
          {!token.revokedAt&&<button type="button" disabled={busy} onClick={()=>revoke(token.id)}>Revoke {token.name}</button>}
        </li>)}</ul>:<p className="portable-settings-empty">{paged?'No older workspace tokens.':'No workspace tokens yet.'}</p>}
        {(paged||page.next)&&<nav aria-label="Token pages">
          {paged&&<button type="button" disabled={busy} onClick={()=>void run(()=>load())}>Newest tokens</button>}
          {page.next&&<button type="button" disabled={busy} onClick={()=>void run(()=>load(page.next??undefined))}>Older tokens</button>}
        </nav>}
      </section>
      <section aria-label="API request example">
        <details>
          <summary>API request example</summary>
          <p>Use <code>Authorization: Bearer &lt;token&gt;</code> with <code>GET /api/v1/records/contacts</code>.
            The same path supports <code>companies</code>, <code>deals</code>, <code>tasks</code>, <code>leads</code> and <code>tickets</code>.</p>
        </details>
      </section>
    </section>
  </main>;
}
