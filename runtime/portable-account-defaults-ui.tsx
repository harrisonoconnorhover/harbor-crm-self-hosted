'use client';

import {useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {accountLanguages,dateFormats,numberFormats,supportedCurrencies,workspaceDate,workspaceNumber,type AccountDefaults,type AccountDefaultsState} from '../lib/portable-account-defaults';

export function AccountDefaultsForm({initial}:{initial:AccountDefaultsState}){
  const router=useRouter();
  const [draft,setDraft]=useState(initial.defaults),[revision,setRevision]=useState(initial.revision);
  const [saving,setSaving]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  function change<K extends keyof AccountDefaults>(field:K,value:AccountDefaults[K]){
    setDraft(previous=>({...previous,[field]:value}));setMessage('');setError('');
  }
  async function save(event:FormEvent){
    event.preventDefault();if(saving)return;
    setSaving(true);setMessage('');setError('');
    try{
      const response=await fetch('/api/workspace-settings',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({...draft,revision})});
      const data=await response.json() as AccountDefaultsState&{error?:string};
      if(!response.ok)throw Error(data.error||'Could not save account defaults.');
      setRevision(data.revision);setDraft(data.defaults);setMessage('Account defaults saved.');router.refresh();
    }catch(e){setError(e instanceof Error?e.message:'Could not confirm the change. Reload and check your settings.');}
    finally{setSaving(false);}
  }
  let sampleDate='';
  try{sampleDate=workspaceDate('2026-07-15T16:30:00Z',draft);}catch{/* The time zone can be incomplete while typing. */}
  return <form className="portable-defaults-form" onSubmit={save}>
    <fieldset disabled={saving}>
      <label>Workspace name<input value={draft.name} required maxLength={100} onChange={e=>change('name',e.target.value)}/></label>
      <label>Time zone<input list="workspace-time-zones" value={draft.timeZone} required maxLength={100} onChange={e=>change('timeZone',e.target.value)}/></label>
      <datalist id="workspace-time-zones">{['UTC',...Intl.supportedValuesOf('timeZone').filter(zone=>zone!=='UTC')].map(zone=><option key={zone} value={zone}/>)}</datalist>
      <label>Currency<select value={draft.currency} onChange={e=>change('currency',e.target.value)}>{supportedCurrencies.map(value=><option key={value}>{value}</option>)}</select></label>
      <p>Deal amounts and forecasts use this currency. Changing it keeps the entered amounts. Products, quotes and invoices retain their USD prices.</p>
      <label>Language for dates and numbers<select value={draft.language} onChange={e=>change('language',e.target.value as AccountDefaults['language'])}>
        {Object.entries(accountLanguages).map(([key,name])=><option value={key} key={key}>{name}</option>)}</select></label>
      <label>Date format<select value={draft.dateFormat} onChange={e=>change('dateFormat',e.target.value as AccountDefaults['dateFormat'])}>
        {Object.entries(dateFormats).map(([key,name])=><option value={key} key={key}>{name}</option>)}</select></label>
      <label>Number format<select value={draft.numberFormat} onChange={e=>change('numberFormat',e.target.value as AccountDefaults['numberFormat'])}>
        {Object.entries(numberFormats).map(([key,name])=><option value={key} key={key}>{name}</option>)}</select></label>
      <p>Preview · {sampleDate||'Enter a valid time zone'} · {workspaceNumber(1234.56,draft,'money')}</p>
      <button type="submit">{saving?'Saving…':'Save account defaults'}</button>
    </fieldset>
    {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
  </form>;
}
