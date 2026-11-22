'use client';

import {useRef,useState,type FormEvent} from 'react';
import {DateTimeInput} from '../app/property-datetime';
import type {PortableArchiveInput,PortableArchiveReceipt} from '../lib/portable-contact-archive';
import type {PortableRecordKind} from '../lib/portable-records';
import {portableRecordBulkLimit} from '../lib/portable-record-bulk';
import type {PortableRecycleScope} from './portable-contact-recycle-ui';
import {PortableRecordMerge} from './portable-record-merge-ui';

export type PortableBulkSelection=Map<string,{revision:number;name:string}>;
export type PortableBulkProperty={id:string;label:string;type:string;options?:readonly string[];optionLabels?:Record<string,string>};
const UNASSIGNED='unassigned';

function BulkDateTimeValue(){
  const [value,setValue]=useState('');
  return <div>
    <span>Value</span>
    <DateTimeInput label="Value" value={value} onChange={setValue} required/>
    <input type="hidden" name="value" value={value}/>
  </div>;
}

// Owner assignment is one all-or-nothing request. Archive runs one record at a
// time, like native Harbor, and stops at the first failure so the confirmed
// prefix is clear. Each record keeps its request ID so a retry replays it.
export function PortableRecordBulkBar({kind,selected,assignees,properties,scope,limitedEdit=false,canMerge=true,canDelete=true,disabled,onBusy,onClear,onDone}:{
  kind:PortableRecordKind;selected:PortableBulkSelection;assignees:{id:string;label:string}[];properties:PortableBulkProperty[];scope?:PortableRecycleScope;
  limitedEdit?:boolean;canMerge?:boolean;canDelete?:boolean;disabled?:boolean;onBusy:(busy:boolean)=>void;onClear:()=>void;
  // keep lists records that should stay selected, e.g. those not yet archived after a stop.
  onDone:(message:string,keep?:string[])=>void;
}){
  const [assignee,setAssignee]=useState('');
  const [propertyId,setPropertyId]=useState('');
  const [mode,setMode]=useState<'replace'|'clear'|'append'|'remove'>('replace');
  const [confirming,setConfirming]=useState(false);
  const [error,setError]=useState('');
  const [progress,setProgress]=useState('');
  const sending=useRef(false);
  const archiveRequests=useRef(new Map<string,PortableArchiveInput>());
  const plural=kind==='companies'?'companies':kind;
  const query=scope?'?'+new URLSearchParams(scope):'';

  async function run(work:()=>Promise<void>){
    if(sending.current||disabled)return;
    sending.current=true;
    onBusy(true);
    setError('');
    try{await work();}
    finally{sending.current=false;onBusy(false);}
  }

  function assign(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!assignee)return;
    void run(async()=>{
      try{
        const response=await fetch('/api/crm'+query,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          action:'assignOwners',kind,assigneeId:assignee===UNASSIGNED?null:assignee,
          records:[...selected].map(([id,{revision}])=>({id,expectedRevision:revision})),
        })});
        const result=await response.json() as {changed?:number;error?:string};
        if(!response.ok||result.changed===undefined){setError(result.error??'Could not assign the selected records.');return;}
        setAssignee('');
        onDone(result.changed===1?'Updated the owner of 1 record.':'Updated the owner of '+result.changed+' records.');
      }catch{setError('Harbor could not confirm the owner change. Refresh the list to check.');}
    });
  }

  const property=properties.find(choice=>choice.id===propertyId);
  const multiple=property?.type==='multiselect';
  const move=kind==='deals'&&(property?.id==='stage'||property?.id==='pipeline');
  function editProperty(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!property)return;
    const form=new FormData(event.currentTarget);
    const raw=form.getAll('value').map(String);
    const value=mode==='clear'?undefined:multiple?raw:property.type==='number'?(raw[0]===''?null:Number(raw[0])):
      property.type==='checkbox'?raw[0]==='true':raw[0]??'';
    void run(async()=>{
      try{
        const response=await fetch('/api/crm'+query,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          action:'editProperty',kind,field:property.id,mode,value,
          records:[...selected].map(([id,{revision}])=>({id,expectedRevision:revision})),
        })});
        const result=await response.json() as {changed?:number;error?:string};
        if(!response.ok||result.changed===undefined){setError(result.error??'Could not update the selected records.');return;}
        setPropertyId('');setMode('replace');
        onDone(property.label+' updated on '+result.changed+(result.changed===1?' record.':' records.'));
      }catch{setError('Harbor could not confirm the property change. Refresh the list to check.');}
    });
  }

  function archive(){
    void run(async()=>{
      const rows=[...selected];
      let done=0;
      for(const [id,{revision,name}] of rows){
        setProgress('Archiving '+(done+1)+' of '+rows.length+'…');
        const key=query+':'+id;
        const previous=archiveRequests.current.get(key);
        const request:PortableArchiveInput=previous?.expectedRevision===revision&&previous.kind===kind?previous:
          {kind,action:'archive',id,expectedRevision:revision,requestId:crypto.randomUUID()};
        archiveRequests.current.set(key,request);
        try{
          const response=await fetch('/api/recycle-bin'+query,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
          // A stale revision was rejected before writing. Uncertain responses still need receipt replay.
          if(response.status===409)archiveRequests.current.delete(key);
          const result=await response.json() as {receipt?:PortableArchiveReceipt;error?:string}|null;
          if(!response.ok||result?.receipt?.id!==id||!result.receipt.archivedAt){
            setProgress('');
            setError((done?'Archived '+done+' of '+rows.length+'. ':'')+'Stopped at '+name+': '+(result?.error??'Harbor could not confirm the archive.'));
            if(done)onDone('Archived '+done+' of '+rows.length+' selected '+plural+'.',rows.slice(done).map(([rest])=>rest));
            return;
          }
        }catch{
          setProgress('');
          setError((done?'Archived '+done+' of '+rows.length+'. ':'')+'Harbor could not confirm '+name+'. Retry to check the same request.');
          return;
        }
        done++;
      }
      setProgress('');
      setConfirming(false);
      archiveRequests.current.clear();
      onDone('Archived '+done+' '+(done===1?'record':plural)+'. Restore them from the Recycle Bin.');
    });
  }

  if(!selected.size)return null;
  return <section className="portable-record-bulk" aria-label={'Selected '+plural}>
    <p>{selected.size} selected on this page{selected.size>=portableRecordBulkLimit?' (the limit)':''}.</p>
    <div className="portable-record-bulk-fields">
      <form onSubmit={assign} aria-label={'Assign an owner to selected '+plural}>
        <fieldset disabled={disabled}>
          <label>Record owner <select value={assignee} onChange={event=>setAssignee(event.target.value)}>
            <option value="">Choose an owner</option>{!limitedEdit&&<option value={UNASSIGNED}>Unassigned</option>}
            {assignees.map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </select></label>
          <button type="submit" disabled={!assignee}>Assign owner</button>
        </fieldset>
      </form>
      <form onSubmit={editProperty} aria-label={'Edit a property on selected '+plural}>
        <fieldset disabled={disabled}>
          <label>Property <select value={propertyId} onChange={event=>{setPropertyId(event.target.value);setMode('replace');}}>
            <option value="">Choose a property</option>
            {properties.map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </select></label>
          {property&&<label>Change <select value={mode} onChange={event=>setMode(event.target.value as typeof mode)}>
            <option value="replace">{move?'Move to':'Replace with'}</option>{!move&&<option value="clear">Clear</option>}
            {multiple&&<><option value="append">Add options</option><option value="remove">Remove options</option></>}
          </select></label>}
          {property&&mode!=='clear'&&(property.options&&(property.type==='select'||multiple)
            ?<label>Value <select name="value" multiple={multiple} required={!multiple} defaultValue={multiple?[]:''}>
              {!multiple&&<option value="">Choose a value</option>}
              {property.options.map(option=><option key={option} value={option}>{property.optionLabels?.[option]??option}</option>)}
            </select></label>
            :property.type==='checkbox'?<label>Value <select name="value" defaultValue="true"><option value="true">Yes</option><option value="false">No</option></select></label>
            :property.type==='datetime'?<BulkDateTimeValue key={property.id}/>
            :<label>Value <input name="value" type={({number:'number',date:'date',email:'email',url:'url'} as Record<string,string>)[property.type]??'text'}
              step={property.type==='number'?'any':undefined}/></label>)}
          <button type="submit" disabled={!property}>Apply to selected</button>
        </fieldset>
      </form>
    </div>
    {canMerge&&canDelete&&!limitedEdit&&kind!=='deals'&&selected.size===2&&<PortableRecordMerge key={[...selected.keys()].join(':')} kind={kind} scope={scope} disabled={disabled} onBusy={onBusy}
      records={[...selected].map(([id,{name}])=>({id,name}))} onDone={message=>{archiveRequests.current.clear();onDone(message);}}
      labels={{name:{label:'Name'},domain:{label:'Domain'},email:{label:'Email'},recordOwner:{label:kind==='contacts'?'Contact owner':'Company owner'},
        primaryCompanyId:{label:'Primary company'},
        ...Object.fromEntries(properties.map(choice=>[choice.id,{label:choice.label,optionLabels:choice.optionLabels}]))}}/>}
    {canDelete&&(confirming?<div>
      <p>Archive {selected.size} selected {selected.size===1?'record':plural}? They will be hidden from active views and can be restored from the Recycle Bin.</p>
      <button type="button" disabled={disabled} onClick={archive}>{error?'Retry archive':'Confirm archive'}</button>{' '}
      <button type="button" disabled={disabled} onClick={()=>{setConfirming(false);setError('');}}>Keep records</button>
    </div>:<button type="button" disabled={disabled} onClick={()=>setConfirming(true)}>Archive selected</button>)}{' '}
    <button type="button" disabled={disabled} onClick={()=>{archiveRequests.current.clear();setError('');setConfirming(false);onClear();}}>Clear selection</button>
    {progress&&<p role="status">{progress}</p>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
