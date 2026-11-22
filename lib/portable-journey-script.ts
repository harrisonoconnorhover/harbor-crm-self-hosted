// Classic script executed on the customer site. Install is passive until its consent manager calls start().
export const journeyScript=String.raw`(()=>{
  'use strict';
  const script=document.currentScript;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const siteId=script?.dataset.site;
  if(!uuid.test(siteId)||window.HarborJourney)return;
  const harbor=new URL(script.src).origin;
  const key='harbor:journey:'+siteId;
  const lifetime=30*24*60*60*1000;
  const publicPaths=new Set(['/']);
  for(const entry of (script.dataset.paths||'').split(',')){
    const path=entry.trim();
    if(path.length<=256&&/^\/(?:[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\/?)?$/i.test(path))publicPaths.add(path);
  }
  let active=false,identity=null,sessionSource=null,pending=null;
  const safeCode=value=>value&&/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/.test(value)?value:undefined;
  const permitted=()=>navigator.globalPrivacyControl!==true;
  function current(){
    if(!active)return null;
    if(!permitted()){stop();return null;}
    const now=Date.now();
    if(identity&&identity.until>now)return identity;
    try{
      const saved=JSON.parse(localStorage.getItem(key));
      if(saved&&uuid.test(saved.visitor)&&Number.isFinite(saved.until)&&saved.until>now&&saved.until<=now+lifetime){
        identity={visitor:saved.visitor,until:saved.until};return identity;
      }
    }catch{/* Storage may be disabled. */}
    identity={visitor:crypto.randomUUID(),until:now+lifetime};
    try{localStorage.setItem(key,JSON.stringify(identity));}catch{/* In-memory tracking lasts for this page. */}
    return identity;
  }
  function source(url){
    const campaign=safeCode(url.searchParams.get('utm_campaign'));
    const medium=safeCode(url.searchParams.get('utm_medium'));
    const label=safeCode(url.searchParams.get('utm_source'));
    let ref;
    try{ref=new URL(document.referrer);}catch{/* A direct visit has no referrer. */}
    if(!label&&!medium&&!campaign&&(sessionSource||ref?.origin===location.origin)){
      try{
        const last=sessionSource||JSON.parse(sessionStorage.getItem(key+':source'));
        if(last&&last.until>Date.now()&&last.until<=Date.now()+1800000&&safeCode(last.data?.source)){
          return {source:last.data.source,medium:safeCode(last.data.medium),campaign:safeCode(last.data.campaign)};
        }
      }catch{/* A new session starts without earlier campaign data. */}
    }
    const host=ref&&ref.origin!==location.origin&&/^https?:$/.test(ref.protocol)&&safeCode(ref.hostname);
    const data={source:label||host||'direct',medium:medium||(host?'referral':undefined),campaign};
    sessionSource={until:Date.now()+1800000,data};
    try{sessionStorage.setItem(key+':source',JSON.stringify(sessionSource));}catch{}
    return data;
  }
  function page(){
    const visitor=current()?.visitor;
    if(!visitor)return;
    const url=new URL(location.href);
    const path=publicPaths.has(url.pathname)?url.pathname:'/other';
    const body=JSON.stringify({siteId,visitor,eventId:crypto.randomUUID(),path,...source(url)});
    // Analytics is best effort; the host page and its form must work offline.
    pending=fetch(harbor+'/api/public/journey?siteId='+siteId,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',
      redirect:'error',keepalive:true,headers:{'content-type':'text/plain;charset=UTF-8'},body}).catch(()=>{});
    return pending;
  }
  function formId(value){
    try{
      const url=new URL(value,location.href);
      const match=/^\/forms\/([^/]+)\/?$/.exec(url.pathname);
      if(url.origin===harbor&&!url.username&&!url.password&&match&&uuid.test(match[1]))return match[1];
    }catch{}
    return null;
  }
  function sendFrame(frame,id,visitor){
    frame.contentWindow?.postMessage({type:'harbor:journey',formId:id,journey:visitor?{siteId,visitor}:null},harbor);
  }
  function frames(visitor){
    for(const frame of document.querySelectorAll('iframe[src]')){
      const id=formId(frame.src);
      if(id)sendFrame(frame,id,visitor);
    }
  }
  function receive(event){
    if(event.origin!==harbor||event.data?.type!=='harbor:journey-request')return;
    for(const frame of document.querySelectorAll('iframe[src]')){
      const id=formId(frame.src);
      if(id&&frame.contentWindow===event.source&&event.data.formId===id){
        Promise.resolve(pending).then(()=>{
          if(active&&formId(frame.src)===id&&frame.contentWindow===event.source)sendFrame(frame,id,current()?.visitor);
        });
        return;
      }
    }
  }
  function decorate(event){
    const link=event.target?.closest?.('a[href]');
    if(!link||!formId(link.href))return;
    const previous=link.href,url=new URL(previous);
    if(url.hash)return;
    const visitor=current()?.visitor;
    if(!visitor)return;
    url.hash='harbor-journey='+siteId+'.'+visitor;
    link.href=url.href;
    setTimeout(()=>{if(link.href===url.href)link.href=previous;},0);
  }
  function storageChange(event){if(event.key===key&&!event.newValue)stop();}
  function start(){
    if(!permitted()){stop();return;}
    if(active)return pending;
    active=true;
    window.addEventListener('message',receive);
    window.addEventListener('storage',storageChange);
    document.addEventListener('click',decorate,true);
    document.addEventListener('auxclick',decorate,true);
    const sent=page();
    Promise.resolve(sent).then(()=>{if(active)frames(current()?.visitor);});
    return sent;
  }
  function stop(){
    const wasActive=active;
    active=false;identity=null;sessionSource=null;pending=null;
    try{localStorage.removeItem(key);}catch{}
    try{sessionStorage.removeItem(key+':source');}catch{}
    window.removeEventListener('message',receive);
    window.removeEventListener('storage',storageChange);
    document.removeEventListener('click',decorate,true);
    document.removeEventListener('auxclick',decorate,true);
    if(wasActive)frames(null);
  }
  if(script.dataset.landingConsent==='true'){
    const panel=document.querySelector('[data-journey-consent]');
    const button=panel?.querySelector('[data-journey-toggle]'),status=panel?.querySelector('[data-journey-status]');
    if(button&&status){
      // The preference belongs to this registered site, even when Harbor serves several tenants on one origin.
      const consentKey=key+':consent';
      const readConsent=()=>{try{return Number(localStorage.getItem(consentKey));}catch{return 0;}};
      const clearConsent=()=>{try{localStorage.removeItem(consentKey);}catch{}};
      function render(){
        button.hidden=!permitted();
        button.textContent=active?'Stop visit measurement':'Allow visit measurement';
        status.textContent=!permitted()?'Global Privacy Control is on. Visit measurement is off.':
          active?'Visit measurement is on for this site.':'Optional visit measurement links pages you visit with inquiries you submit.';
      }
      function sync(){
        const until=readConsent(),now=Date.now();
        if(permitted()&&until>now&&until<=now+lifetime)start();
        else{if(until)clearConsent();if(active||!permitted())stop();}
        render();
      }
      button.addEventListener('click',()=>{
        if(active||!permitted()){clearConsent();stop();}
        else{
          try{localStorage.setItem(consentKey,String(Date.now()+lifetime));}catch{}
          start();
        }
        render();
      });
      window.addEventListener('storage',event=>{if(event.key===consentKey||event.key===null)sync();});
      sync();panel.hidden=false;
    }
  }
  window.HarborJourney=Object.freeze({start,page,stop});
  window.dispatchEvent(new Event('harbor:journey-ready'));
})();`;
