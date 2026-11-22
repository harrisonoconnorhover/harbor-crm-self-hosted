'use client';

import {useEffect,useRef,useState} from 'react';
import type {AircallWorkspace} from 'aircall-everywhere';
import {aircallActivityId} from '../lib/aircall-activity';
import type {PortableOutreach} from '../lib/portable-contact-activities';

const providerOrigin='https://workspace.aircall.io';
const internationalPhone=(value:string)=>value.trim().replace(/[ ().-]/g,'');
type CallDraft={providerId:number;activity:PortableOutreach};

export function PortableAircall({phone,saving,onLog,logLabel='Log answered call'}:{phone:string;saving:boolean;logLabel?:string;onLog:(input:PortableOutreach,providerId:number)=>Promise<boolean>}){
  const number=internationalPhone(phone);
  const [open,setOpen]=useState(false),[ready,setReady]=useState(false);
  const [src,setSrc]=useState(''),[notice,setNotice]=useState('');
  const [drafts,setDrafts]=useState<CallDraft[]>([]);
  const frame=useRef<HTMLIFrameElement>(null),phoneApp=useRef<AircallWorkspace|null>(null);
  const canDial=/^\+[1-9]\d{5,14}$/.test(number);

  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    const outgoing=new Map<number,{at:number;answered:boolean}>();
    // The SDK installs a window listener. Only its own visible frame may deliver
    // provider events, and leaving the record must detach the listener.
    const bus={addEventListener:(name:string,listener:(event:MessageEvent)=>void)=>{
      window.addEventListener(name,event=>{
        if(event instanceof MessageEvent&&event.origin===providerOrigin&&event.source===frame.current?.contentWindow)listener(event);
      },{signal:controller.signal});
    }};
    void import('aircall-everywhere').then(({default:entry})=>{
      if(controller.signal.aborted)return;
      const Workspace=typeof entry==='function'?entry:entry.default;
      const app=new Workspace({window:bus,debug:false,onLogin:()=>{setReady(true);setNotice('');},
        onLogout:()=>{outgoing.clear();setReady(false);setNotice('Sign in to Aircall to dial.');}});
      phoneApp.current=app;
      app.on('outgoing_call',event=>{
        if(!event||typeof event!=='object'||!('to' in event)||event.to!==number||!('call_id' in event)||
          typeof event.call_id!=='number'||!Number.isSafeInteger(event.call_id)||event.call_id<=0)return;
        if(!outgoing.has(event.call_id))outgoing.set(event.call_id,{at:Date.now(),answered:false});
      });
      app.on('outgoing_answered',event=>{
        if(!event||typeof event!=='object'||!('call_id' in event)||typeof event.call_id!=='number')return;
        const call=outgoing.get(event.call_id);
        if(call)call.answered=true;
      });
      app.on('call_ended',event=>{
        if(!event||typeof event!=='object'||!('call_id' in event)||typeof event.call_id!=='number')return;
        const providerId=event.call_id,call=outgoing.get(providerId);
        if(!call)return;
        outgoing.delete(providerId);
        if(!call.answered){setNotice('Call ended without a confirmed answer.');return;}
        const activity:PortableOutreach={id:aircallActivityId(providerId),kind:'Call',occurredAt:call.at,summary:'Answered outbound Aircall call #'+providerId};
        setDrafts(prior=>prior.some(item=>item.providerId===providerId)?prior:[...prior,{providerId,activity}]);
      });
      setSrc(app.getUrlToLoad());
    }).catch(()=>{if(!controller.signal.aborted)setNotice('The dialer could not load. Close it and try again.');});
    return ()=>{controller.abort();phoneApp.current=null;};
  },[open,number]);

  return <div className="portable-aircall">
    <button type="button" aria-expanded={open} onClick={()=>{setSrc('');setReady(false);setNotice('');setOpen(!open);}}>
      {open?'Close Aircall dialer':'Open Aircall dialer'}
    </button>
    {open&&<>
      {src&&<iframe ref={frame} src={src} title="Aircall Workspace" allow="microphone; autoplay; clipboard-read; clipboard-write; hid" referrerPolicy="no-referrer"/>}
      {canDial?<button type="button" disabled={!ready} onClick={()=>{
        const app=phoneApp.current;
        app?.send('dial_number',{phone_number:number},ok=>{
          if(app===phoneApp.current)setNotice(ok?'Dial request accepted by Aircall.':'Aircall could not open the number. Try again.');
        });
      }}>Dial {phone}</button>:<p>Save a phone number with its country code to dial this contact.</p>}
      {notice&&<p role="status">{notice}</p>}
    </>}
    {drafts.map(({providerId,activity})=><div key={providerId}>
      <span>Answered call #{providerId}</span>{' '}
      <button type="button" disabled={saving} onClick={async()=>{
        if(await onLog(activity,providerId))setDrafts(prior=>prior.filter(item=>item.providerId!==providerId));
      }}>{logLabel}</button>{' '}
      <button type="button" disabled={saving} onClick={()=>setDrafts(prior=>prior.filter(item=>item.providerId!==providerId))}>Dismiss</button>
    </div>)}
  </div>;
}
