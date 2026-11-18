'use client';

import {useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import type {PortableTaskQueue,PortableTaskQueueInput} from '../lib/portable-task-queues';

export function PortableTaskQueues({queues}:{queues:PortableTaskQueue[]}){
  const router=useRouter();
  const creation=useRef<{name:string;id:string}|null>(null);
  const [name,setName]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');

  async function save(input:PortableTaskQueueInput){
    setBusy(true);setError('');setStatus('');
    try{
      const response=await fetch('/api/task-queues',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      const result=await response.json() as {error?:string};
      if(!response.ok)throw Error(result.error||'Could not save the queue.');
      if(input.action==='create'){creation.current=null;setName('');}
      setStatus(input.action==='remove'?'Queue removed.':'Queue saved.');
      if(input.action==='remove'&&new URLSearchParams(window.location.search).get('taskQueueId')===input.id){
        router.replace('/?kind=tasks');
      }else router.refresh();
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }

  return <details>
    <summary>Manage task queues</summary>
    <form onSubmit={event=>{
      event.preventDefault();
      const trimmed=name.trim();
      const pending=creation.current?.name===trimmed?creation.current:{name:trimmed,id:crypto.randomUUID()};
      creation.current=pending;
      void save({action:'create',...pending});
    }}>
      <label>New queue name<input value={name} onChange={event=>setName(event.target.value)} maxLength={80} required/></label>
      <button disabled={busy||!name.trim()}>Add queue</button>
    </form>
    <ul>{queues.map(queue=><li key={queue.id+':'+queue.revision}>
      <form onSubmit={event=>{
        event.preventDefault();
        const renamed=String(new FormData(event.currentTarget).get('name')??'');
        void save({action:'rename',id:queue.id,revision:queue.revision,name:renamed});
      }}>
        <label>Queue name<input name="name" defaultValue={queue.name} maxLength={80} required/></label>
        <button disabled={busy}>Rename queue</button>{' '}
        <button type="button" disabled={busy} onClick={()=>{
          if(window.confirm('Remove '+queue.name+'?'))void save({action:'remove',id:queue.id,revision:queue.revision});
        }}>Remove queue</button>
      </form>
    </li>)}</ul>
    {status&&<p role="status">{status}</p>}
    {error&&<p role="alert">{error}</p>}
  </details>;
}
