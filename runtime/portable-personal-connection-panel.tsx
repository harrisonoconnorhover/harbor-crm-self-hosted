'use client';

import {CalendarDays,Mail} from 'lucide-react';
import {useState} from 'react';
import {useRouter} from 'next/navigation';

export type PersonalConnectionStatus={id:string;email:string;needsReconnect:boolean}|null|'unavailable';

const providers={
  gmail:{name:'Gmail',description:'Find received emails for your private Contacts and choose which ones to log. Harbor won’t send mail using this connection.',view:'email-settings',brand:'Google',group:'google'},
  calendar:{name:'Google Calendar',description:'Check whether your primary calendar is free or busy. Harbor won’t read event details or send invitations using this connection.',view:'calendar',brand:'Google',group:'google'},
  'outlook-mail':{name:'Outlook Mail',description:'Find recent messages from a private contact and choose which ones to add to their timeline.',view:'email-settings',brand:'Microsoft',group:'outlook'},
  'outlook-calendar':{name:'Outlook Calendar',description:'Check availability on your primary calendar and choose past meetings to log on a private contact.',view:'calendar',brand:'Microsoft',group:'outlook'},
} as const;
function connectionNotices(brand:string):Record<string,string>{
  return {
    connected:brand+' connection saved.',
    expired:'That connection attempt expired or was already used. Start again from this browser.',
    permissions:brand+' did not grant the requested read access. Try connecting again.',
    denied:brand+' access was not granted.',
    wrong_account:brand==='Microsoft'?'Choose the Microsoft mailbox whose primary address matches your Harbor email.':'Choose the same Google account you used to sign in to Harbor.',
    reconnect:'Start a new connection from Harbor and grant the requested read permissions.',
    setup:'This connection needs setup by your Harbor administrator.',
    provider_unavailable:brand+' took too long to complete this connection. Start a new connection and try again.',
    failed:brand+' could not complete the connection. Try again.',
  };
}

export function PortableConnectionPanel({provider,status:initialStatus,outcome}:{provider:keyof typeof providers;status:PersonalConnectionStatus;outcome?:string}){
  const router=useRouter();
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<{ok:boolean;message:string}>();
  const [removingId,setRemovingId]=useState<string|null>(null);
  const unavailable=initialStatus==='unavailable';
  const status=unavailable?null:initialStatus;
  const removing=status?.id===removingId;
  const {name,description,brand,group,view}=providers[provider];
  const Icon=view==='email-settings'?Mail:CalendarDays;
  const notices=connectionNotices(brand);
  const connection=unavailable?'unavailable':status?.needsReconnect?'reconnect':status?'connected':'disconnected';
  const connectionLabel=unavailable?'Status unavailable':status?.needsReconnect?'Reconnect needed':status?'Connected':'Not connected';
  const endpoint='/api/'+group+'/connections?provider='+provider;
  const notice=outcome&&Object.hasOwn(notices,outcome)?notices[outcome]:undefined;
  async function run(disconnect:boolean){
    if(busy||!status||(disconnect&&!removing))return;
    setBusy(true);
    setResult(undefined);
    try{
      const response=await fetch(endpoint+(disconnect?'':'&action=check'),{
        method:disconnect?'DELETE':'POST',headers:{'content-type':'application/json'},
        ...(disconnect?{body:JSON.stringify({id:status.id})}:{}),
      });
      const data=await response.json() as {disconnected?:true;connection?:'ok';error?:string}|null;
      if(!response.ok&&(!disconnect||response.status<500)&&typeof data?.error==='string'&&data.error){
        setResult({ok:false,message:data.error});
        return;
      }
      if(!response.ok||(disconnect?data?.disconnected!==true:data?.connection!=='ok'))throw Error();
      setResult({ok:true,message:disconnect?name+' disconnected from Harbor.':name+' connection verified.'});
      if(disconnect)router.replace('/?view='+view);
    }catch{
      setResult({ok:false,message:disconnect?'Could not confirm the disconnect. Check the connection below before trying again.':
        'Could not verify this connection. Try again.'});
    }finally{setRemovingId(null);setBusy(false);router.refresh();}
  }

  return <section className="portable-provider-card" aria-label={'Personal '+name+' connection'}>
    <header className="portable-provider-heading">
      <span className="portable-provider-icon"><Icon size={20} aria-hidden="true"/></span>
      <div>
        <h2>Personal {name}</h2>
        <p>{description}</p>
      </div>
    </header>
    <div className="portable-provider-connection">
      <div className="portable-provider-account">
        <span className="portable-provider-status" data-status={connection}>{connectionLabel}</span>
        {status&&<span>{status.email}</span>}
      </div>
      <div className="portable-provider-actions">
        {unavailable?<button type="button" onClick={()=>router.refresh()}>Refresh connection status</button>:<>
          {status&&!status.needsReconnect&&!removing&&<button type="button" disabled={busy} onClick={()=>void run(false)}>Check {name} connection</button>}
          {(!status||status.needsReconnect)&&!removing&&<form action={endpoint} method="post">
            <button type="submit" disabled={busy}>{status?'Reconnect':'Connect'} {name}</button>
          </form>}
          {status&&!removing&&<button type="button" disabled={busy} onClick={()=>setRemovingId(status.id)}>Disconnect</button>}
        </>}
      </div>
    </div>
    {unavailable&&<p role="alert">Saved connection status is temporarily unavailable.</p>}
    {!unavailable&&(result?<p role={result.ok?'status':'alert'}>{result.message}</p>:
      notice&&(outcome!=='connected'||status)&&<p role={outcome==='connected'?'status':'alert'}>{notice}</p>)}
    {status&&removing&&<div className="portable-provider-confirmation">
      <p>Harbor will stop using this account. {brand==='Microsoft'?'You can also revoke Harbor’s permissions in your Microsoft account.':'To also remove the grant at Google, remove Harbor’s access in your Google Account.'}</p>
      <div className="portable-provider-actions">
        <button type="button" disabled={busy} onClick={()=>void run(true)}>Disconnect {name}</button>
        <button type="button" disabled={busy} onClick={()=>setRemovingId(null)}>Keep connected</button>
      </div>
    </div>}
  </section>;
}
