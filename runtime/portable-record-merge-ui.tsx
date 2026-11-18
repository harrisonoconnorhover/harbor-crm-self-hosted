'use client';

import {useRef,useState} from 'react';
import {
  mergeValue,portableMergeLinks,
  type PortableMergeKind,type PortableMergePreview,type PortableMergeReceipt,type PortableMergeSide,
} from '../lib/portable-record-merge';
import type {PortableRecycleScope} from './portable-contact-recycle-ui';

const linkLabels={contacts:['Contact','Contacts'],deals:['Deal','Deals'],leads:['Lead','Leads'],tickets:['Ticket','Tickets'],
  tasks:['Task','Tasks'],activities:['activity log','activity logs'],associations:['association','associations'],
  meetings:['meeting','meetings'],notes:['Note','Notes'],files:['file','files'],
  inquiries:['form inquiry','form inquiries'],segments:['static segment','static segments']};
const nouns={contacts:['Contact','Contacts'],companies:['Company','Companies']} as const;
const display=(value:unknown,options?:Record<string,string>)=>{
  if(value===undefined||value===null||value==='')return '—';
  if(typeof value==='boolean')return value?'Yes':'No';
  if(Array.isArray(value))return value.join(', ')||'—';
  if(typeof value==='object'&&'label' in value)return String(value.label);
  return options?.[String(value)]??String(value);
};

// Merge two selected Contacts or Companies: choose the one to keep, review the
// values that differ, then commit once. The request ID is kept for a retry of the same review.
export function PortableRecordMerge({kind,records,labels,scope,disabled,onBusy,onDone}:{
  kind:PortableMergeKind;
  records:{id:string;name:string}[];labels:Record<string,{label:string;optionLabels?:Record<string,string>}>;
  scope?:PortableRecycleScope;disabled?:boolean;onBusy:(busy:boolean)=>void;onDone:(message:string)=>void;
}){
  const [keep,setKeep]=useState(records[0]!.id);
  const [preview,setPreview]=useState<PortableMergePreview|null>(null);
  const [choices,setChoices]=useState<Record<string,PortableMergeSide>>({});
  const [error,setError]=useState('');
  const [tried,setTried]=useState(false);
  const sending=useRef(false);
  const attempt=useRef<string|undefined>(undefined);
  const query=scope?'?'+new URLSearchParams(scope):'';
  const other=records.find(record=>record.id!==keep)!;

  async function post<T>(body:unknown,work:(result:T)=>void){
    if(sending.current||disabled)return;
    sending.current=true;onBusy(true);setError('');
    try{
      const response=await fetch('/api/record-merge'+query,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const result=await response.json() as T&{error?:string};
      if(!response.ok){setError(result.error??'Harbor could not merge these records.');return;}
      work(result);
    }catch{setError('Harbor could not confirm the merge. Retry to check the same request.');}
    finally{sending.current=false;onBusy(false);}
  }

  function review(){
    attempt.current=undefined;setTried(false);
    void post<{preview:PortableMergePreview}>({action:'preview',kind,primaryId:keep,secondaryId:other.id},result=>{
      setPreview(result.preview);setChoices(result.preview.defaults);
    });
  }
  function merge(){
    if(!preview)return;
    attempt.current??=crypto.randomUUID();
    setTried(true);
    void post<{receipt:PortableMergeReceipt}>({action:'merge',kind,primaryId:preview.primary.id,secondaryId:preview.secondary.id,
      requestId:attempt.current,expectedRevisions:{primary:preview.primary.revision,secondary:preview.secondary.revision},choices},()=>{
      setPreview(null);attempt.current=undefined;
      onDone('Merged '+preview.secondary.data.name+' into '+preview.primary.data.name+'.');
    });
  }

  const [singular,plural]=nouns[kind];
  if(!preview)return <form aria-label={'Merge the selected '+plural.toLowerCase()} onSubmit={event=>{event.preventDefault();review();}}>
    <fieldset disabled={disabled}><legend>{'Merge '+plural.toLowerCase()}</legend>
      {records.map(record=><label key={record.id}><input type="radio" name="keep" value={record.id} checked={keep===record.id}
        onChange={()=>setKeep(record.id)}/> Keep {record.name}</label>)}
      <button type="submit">Review merge</button>
    </fieldset>
    {error&&<p role="alert">{error}</p>}
  </form>;

  const differing=preview.fields.filter(field=>
    JSON.stringify(mergeValue(preview.primary,field)??null)!==JSON.stringify(mergeValue(preview.secondary,field)??null));
  const links:readonly (keyof typeof linkLabels)[]=portableMergeLinks[kind];
  const moving=links.flatMap(link=>{
    const count=preview.counts[link];
    return count?[count+' '+linkLabels[link][count===1?0:1]]:[];
  });
  const shown=(side:'primary'|'secondary',field:string)=>{
    const value=mergeValue(preview[side],field);
    return field==='primaryCompanyId'&&typeof value==='string'?preview.companyNames?.[value]??'Unavailable company':value;
  };
  return <section aria-label={'Review the '+singular.toLowerCase()+' merge'}>
    <p>Keep <strong>{preview.primary.data.name}</strong> and merge <strong>{preview.secondary.data.name}</strong> into it.
      {' '}{preview.secondary.data.name} will be archived and can&apos;t be restored.</p>
    <p>{moving.length?'Moves to '+preview.primary.data.name+': '+moving.join(', ')+'.':'Nothing else links to '+preview.secondary.data.name+'.'}</p>
    {differing.length?<table><caption>Choose the value to keep</caption>
      <thead><tr><th scope="col">Property</th><th scope="col">{preview.primary.data.name}</th><th scope="col">{preview.secondary.data.name}</th></tr></thead>
      <tbody>{differing.map(field=>{
        const {label,optionLabels}=labels[field]??{label:field};
        return <tr key={field}><th scope="row">{label}</th>
          {(['primary','secondary'] as const).map(side=><td key={side}><label><input type="radio" name={'merge:'+field}
            checked={choices[field]===side} disabled={disabled} onChange={()=>setChoices(current=>({...current,[field]:side}))}/>{' '}
            {display(shown(side,field),optionLabels)}</label></td>)}
        </tr>;
      })}</tbody></table>:<p>Every property matches.</p>}
    <button type="button" disabled={disabled} onClick={merge}>{error&&tried?'Retry merge':'Merge '+plural.toLowerCase()}</button>{' '}
    <button type="button" disabled={disabled} onClick={()=>{setPreview(null);setError('');attempt.current=undefined;}}>Back</button>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
