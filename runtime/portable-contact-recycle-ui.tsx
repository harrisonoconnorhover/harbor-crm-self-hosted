'use client';

import {WorkspaceDate} from './portable-workspace-format';
import {useEffect,useRef,useState} from 'react';
import {PortableCrmHeader} from './portable-crm-header';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {jobDetailsHref} from '../lib/portable-job-labels';
import {portableArchiveKind} from '../lib/portable-contact-archive';
import type {PortableArchivedRecord,PortableArchiveInput,PortableArchiveKind,PortableArchiveReceipt} from '../lib/portable-contact-archive';
import './portable-contacts.css';

type Page={records:PortableArchivedRecord[];next:string|null};
const api='/api/recycle-bin';
export const portableRecycleBinPath='/?view=recycle-bin';
const recordLabels={contacts:'contact',companies:'company',deals:'deal',tasks:'task',leads:'lead',tickets:'ticket'} satisfies Record<PortableArchiveKind,string>;
const listLabels={contacts:'Contacts',companies:'Companies',deals:'Deals',tasks:'Tasks',leads:'Leads',tickets:'Tickets'} satisfies Record<PortableArchiveKind,string>;
const kindQuery=(kind:PortableArchiveKind)=>kind==='contacts'?'':'&kind='+kind;
export type PortableRecycleScope={workspaceId:string;grantId:string};
// The page URL names only the workspace; the API also needs the editor's grant.
export const portableRecycleBinLink=(kind:PortableArchiveKind,workspaceId?:string)=>
  portableRecycleBinPath+kindQuery(kind)+(workspaceId?'&'+new URLSearchParams({workspaceId}):'');
const apiPath=(scope?:PortableRecycleScope,query?:Record<string,string>)=>{
  const params=new URLSearchParams({...query,...scope});
  return api+(params.size?'?'+params:'');
};

export function PortableRecycleAction({action,id,revision,name,kind='contacts',repeating,scope,disabled,onBusy,onDone}:{
  action:PortableArchiveInput['action'];id:string;revision:number;name:string;kind?:PortableArchiveKind;repeating?:boolean;
  scope?:PortableRecycleScope;disabled?:boolean;onBusy?:(busy:boolean)=>void;onDone:(id:string,nextTaskId?:string)=>void;
}){
  const [confirming,setConfirming]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [blockingJob,setBlockingJob]=useState<string>();
  const attempt=useRef<PortableArchiveInput|undefined>(undefined);
  const sending=useRef(false);
  const archive=action==='archive';
  const recordLabel=recordLabels[kind];
  const label=(archive?'Archive ':'Restore ')+recordLabel;

  async function submit(){
    if(sending.current||disabled)return;
    const request=attempt.current ??= {action,id,expectedRevision:revision,requestId:crypto.randomUUID(),...(kind!=='contacts'?{kind}:{})};
    sending.current=true;
    setBusy(true);
    onBusy?.(true);
    setError('');
    setBlockingJob(undefined);
    try{
      const response=await fetch(apiPath(scope),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
      const result=await response.json() as {receipt?:PortableArchiveReceipt;error?:string;blockingJobId?:string}|null;
      if(!response.ok&&result?.error){
        setError(result.error);
        setBlockingJob(result.blockingJobId);
        return;
      }
      if(!response.ok||result?.receipt?.id!==request.id||result.receipt.action!==request.action||
        result.receipt.revision!==request.expectedRevision+1||Boolean(result.receipt.archivedAt)!==archive){
        throw Error('Missing recycle-bin receipt.');
      }
      onDone(result.receipt.id,result.receipt.nextTaskId);
    }catch{
      setError('Harbor could not confirm the change. Retry to check the same request.');
    }finally{
      sending.current=false;
      setBusy(false);
      onBusy?.(false);
    }
  }

  if(archive&&!confirming){
    return <button type="button" onClick={()=>setConfirming(true)} disabled={disabled}>{label}</button>;
  }
  return <div>
    {archive&&<p>Archive <strong>{name}</strong>? It will be hidden from active views. You can restore it from the Recycle Bin. Save any edits you want to keep before archiving.
      {kind==='companies'&&' Linked contacts, deals, leads, tickets and tasks keep their records but show no company until you restore it.'}
      {kind==='deals'&&' Its line items, quotes and invoices are kept. Existing quotes and invoices stay available; new ones need the deal restored.'}
      {repeating&&' Archiving a repeating task keeps its next occurrence or creates one if needed.'}</p>}
    <button type="button" disabled={busy||disabled} onClick={()=>void submit()}>
      {busy?(archive?'Archiving…':'Restoring…'):error?'Retry '+action:archive?'Confirm archive':label}
    </button>{' '}
    {archive&&<button type="button" disabled={busy} onClick={()=>{setConfirming(false);setError('');}}>Keep editing</button>}
    {error&&<p role="alert">{error}{blockingJob&&<> <a href={jobDetailsHref(blockingJob)}>Review blocking job</a></>}</p>}
  </div>;
}

export function PortableRecycleBin({after,email,kind,scope,canRestore=true}:{after?:string;email:string;kind:PortableArchiveKind;scope?:PortableRecycleScope;canRestore?:boolean}){
  const router=useRouter();
  const contacts=kind==='contacts',detail=kind==='contacts'||kind==='companies';
  const workspaceId=scope?.workspaceId,binPath=portableRecycleBinLink(kind,workspaceId);
  const home=(query:Record<string,string>)=>'/?'+new URLSearchParams({...query,...(workspaceId?{workspaceId}:{})});
  const [page,setPage]=useState<Page>();
  const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  const [busyId,setBusyId]=useState<string>();
  useEffect(()=>{
    const controller=new AbortController();
    async function load(){
      try{
        const response=await fetch(apiPath(scope,{...(contacts?{}:{kind}),...(after?{after}:{})}),{signal:controller.signal,cache:'no-store'});
        const result=await response.json() as (Partial<Page>&{error?:string})|null;
        if(!response.ok||!Array.isArray(result?.records)){
          throw Error(result?.error||'Could not load the Recycle Bin.');
        }
        if(!controller.signal.aborted)setPage({records:result.records,next:result.next??null});
      }catch(error){
        if(!controller.signal.aborted)setError(error instanceof Error?error.message:'Could not load the Recycle Bin.');
      }
    }
    void load();
    return ()=>controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the scope's two IDs identify it.
  },[after,retry,kind,contacts,scope?.workspaceId,scope?.grantId]);

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="recycle-bin" workspaceId={workspaceId} recycleHref={binPath}/>
    <section aria-labelledby="portable-recycle-title">
      <h1 id="portable-recycle-title">Recycle Bin</h1>
      <nav aria-label="Archived record types">
        {portableArchiveKind.options.map(option=><Link key={option} href={portableRecycleBinLink(option,workspaceId)}
          aria-current={kind===option?'page':undefined}>{listLabels[option]}</Link>)}
      </nav>
      {canRestore&&<p>Restore an archived {recordLabels[kind]} to return it to {workspaceId?'the shared':'your'} {listLabels[kind]} list.</p>}
      {error?<><p role="alert">{error}</p><button type="button" onClick={()=>{setError('');setRetry(value=>value+1);}}>Retry loading</button></>:
        page?<>
          {page.records.length?<div className="portable-contacts-table"><table>
            <thead><tr><th scope="col">Name</th>{detail&&<th scope="col">{contacts?'Email':'Domain'}</th>}<th scope="col">Archived</th><th scope="col">Archived by</th>{canRestore&&<th scope="col">Actions</th>}</tr></thead>
            <tbody>{page.records.map(record=><tr key={record.id}>
              <th scope="row">{record.name}</th>{detail&&<td>{(contacts?record.email:record.domain)||'—'}</td>}
              <td><time dateTime={record.archivedAt}><WorkspaceDate value={record.archivedAt} day>{new Date(record.archivedAt).toLocaleDateString('en-US')}</WorkspaceDate></time></td>
              <td>{record.archivedBy??'Unknown'}</td>
              {canRestore&&<td><PortableRecycleAction key={record.revision} action="restore" kind={kind} id={record.id} revision={record.revision}
                name={record.name} scope={scope} disabled={!!busyId&&busyId!==record.id} onBusy={busy=>setBusyId(busy?record.id:undefined)}
                onDone={id=>router.replace(kind==='tickets'?'/tickets?'+new URLSearchParams({id,...(workspaceId?{workspaceId}:{})}):home(contacts?{contact:id}:{kind,record:id}))}/></td>}
            </tr>)}</tbody>
          </table></div>:<p>{'No archived '+kind+(after?' on this page.':'.')}</p>}
          {(after||page.next)&&<nav aria-label="Recycle Bin pages">
            {after&&<Link href={binPath}>First page</Link>}{' '}
            {page.next&&<Link href={binPath+'&'+new URLSearchParams({after:page.next})}>Next page</Link>}
          </nav>}
        </>:<p role="status">{'Loading archived '+kind+'…'}</p>}
    </section>
  </main>;
}
