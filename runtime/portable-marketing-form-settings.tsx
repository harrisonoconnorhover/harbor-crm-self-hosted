'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';

type Route={id:string;title:string;enabled:boolean;recipients:string[];salesforce:boolean};
export type MarketingFormSettings={forms:Route[];allowlist:string[];hasSalesforce:boolean;
  recent:{id:string;formId:string;kind:string;state:string;issue:string|null}[]};

export function PortableMarketingFormSettings(){
  const [settings,setSettings]=useState<MarketingFormSettings>(),[selected,setSelected]=useState('');
  const [recipients,setRecipients]=useState<string[]>([]),[salesforce,setSalesforce]=useState(false);
  const [message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function call(body:unknown){
    const response=await fetch('/api/marketing/campaigns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json();
    if(!response.ok)throw Error((result as {error?:string}|null)?.error??'Could not read form routing.');
    return result as MarketingFormSettings;
  }
  function show(data:MarketingFormSettings,id:string){
    const form=data.forms.find(f=>f.id===id)??data.forms[0];
    setSelected(form?.id??'');setRecipients(form?.recipients??[]);setSalesforce(!!form?.salesforce);
  }
  useEffect(()=>{let active=true;void call({action:'formSettings'}).then(data=>{
    if(active){setSettings(data);show(data,'');}
  }).catch(e=>{if(active)setError(e.message);});return ()=>{active=false;};},[]);
  return <section><h2>Website forms</h2><p>Use one form per website and destination. A submission can notify your team and create a record in Salesforce.</p>
    <Link href="/?view=forms">Manage forms and embed codes</Link>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {settings&&(!settings.forms.length?<p>Create a form to set its destinations.</p>:<form className="marketing-builder" onSubmit={async e=>{
      e.preventDefault();setBusy(true);setError('');setMessage('');
      try{const data=await call({action:'configureForm',formId:selected,recipients,salesforce});
        setSettings(data);show(data,selected);setMessage('Saved destinations for new submissions.');
      }catch(e){setError(e instanceof Error?e.message:'Could not save destinations.');}finally{setBusy(false);}
    }}><fieldset disabled={busy}><label>Form<select value={selected} onChange={e=>{show(settings,e.target.value);setMessage('');}}>
      {settings.forms.map(f=><option key={f.id} value={f.id}>{f.title}{f.enabled?'':' (off)'}</option>)}</select></label>
      <div><strong>Notify by email</strong>{settings.allowlist.length?settings.allowlist.map(address=>
        <label className="marketing-check" key={address}><input type="checkbox" checked={recipients.includes(address)}
          onChange={e=>setRecipients(old=>e.target.checked?[...old,address]:old.filter(a=>a!==address))}/>{address}</label>):
        <p>Your operator can add approved team addresses in the installation settings.</p>}</div>
      <div><strong>Salesforce</strong><label className="marketing-check"><input type="checkbox" checked={salesforce} disabled={!settings.hasSalesforce}
        onChange={e=>setSalesforce(e.target.checked)}/>Create a submission record</label>
        {!settings.hasSalesforce&&<p>Your operator can configure the Salesforce object and field mapping.</p>}</div></fieldset>
      <button type="submit">Save destinations</button></form>)}
    {settings&&settings.recent.length>0&&<><h3>Recent form deliveries</h3><ul>{settings.recent.map(r=><li key={r.id}>
      {settings.forms.find(f=>f.id===r.formId)?.title} · {r.kind==='email'?'Team email':'Salesforce'} · {r.state}{r.issue?' · '+r.issue:''}</li>)}</ul></>}
  </section>;
}
