export type FormJourney={siteId:string;visitor:string};
const id=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function journey(siteId:unknown,visitor:unknown):FormJourney|null{
  return typeof siteId==='string'&&typeof visitor==='string'&&id.test(siteId)&&id.test(visitor)?{siteId,visitor}:null;
}

export function acceptFormJourney(formId:string,approvedOrigin:string|undefined,set:(value:FormJourney|null)=>void){
  const permitted=()=>(navigator as Navigator&{globalPrivacyControl?:boolean}).globalPrivacyControl!==true;
  if(window.parent===window){
    // The browser never sends this fragment as part of the HTTP request or referrer.
    const fragment=/^#harbor-journey=([^.]+)\.([^.]+)$/.exec(location.hash);
    if(fragment){
      history.replaceState(history.state,'',location.pathname+location.search);
      set(permitted()?journey(fragment[1],fragment[2]):null);
    }
    return;
  }
  if(!approvedOrigin||!permitted())return;
  function receive(event:MessageEvent){
    if(event.source!==window.parent||event.origin!==approvedOrigin||
       event.data?.type!=='harbor:journey'||event.data.formId!==formId)return;
    set(permitted()?journey(event.data.journey?.siteId,event.data.journey?.visitor):null);
  }
  window.addEventListener('message',receive);
  window.parent.postMessage({type:'harbor:journey-request',formId},approvedOrigin);
  return ()=>window.removeEventListener('message',receive);
}
