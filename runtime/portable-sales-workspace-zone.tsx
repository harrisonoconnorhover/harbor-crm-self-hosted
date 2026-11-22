'use client';
import {useEffect} from 'react';
import {useRouter} from 'next/navigation';

export function SalesWorkspaceZone({specified}:{specified:boolean}){
  const router=useRouter();
  useEffect(()=>{
    if(!specified){
      const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
      if(zone&&zone!=='UTC'){
        const url=new URL(window.location.href);
        url.searchParams.set('taskZone',zone);
        router.replace(url.pathname+url.search,{scroll:false});
      }
    }
    // Back from a completed task can restore a cached document.
    const refresh=(e:PageTransitionEvent)=>{if(e.persisted)router.refresh();};
    window.addEventListener('pageshow',refresh);
    return ()=>window.removeEventListener('pageshow',refresh);
  },[specified,router]);
  return null;
}
