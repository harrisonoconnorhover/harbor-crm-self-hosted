'use client';

import {useEffect,useState} from 'react';
import {portableArticlePath} from '../lib/portable-knowledge';
import type {HelpChange,HelpState} from '../lib/help-center';

const api='/api/knowledge-base?publication=1';
async function settings(id?:string,input?:HelpChange,signal?:AbortSignal){
  const response=await fetch(api+(id&&!input?'&id='+id:''),input?{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),
  }:{cache:'no-store',signal});
  const data=await response.json() as HelpState&{error?:string};
  if(!response.ok)throw Error(data.error??'Could not load help center settings.');
  return data as HelpState;
}

function PublishArticle({topic,published,revision,disabled,onPublish}:{
  topic:string|null;published:boolean;revision:number;disabled:boolean;onPublish:(topic:string|null)=>void;
}){
  const [value,setValue]=useState(topic??'');
  const next=value.trim()||null;
  return <div>
    <label>Public topic (optional)<input maxLength={80} value={value} disabled={disabled}
      onChange={event=>setValue(event.target.value)}/></label>
    <button type="button" disabled={disabled||(published&&next===topic)} onClick={()=>onPublish(next)}>
      {published?'Update public topic':'Publish saved version '+revision}</button>
  </div>;
}

export function HelpCenterControls({article,dirty}:{article?:{id:string;revision:number;archivedAt:number|null};dirty?:boolean}){
  const [state,setState]=useState<HelpState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [refresh,setRefresh]=useState(0),id=article?.id,version=article?.revision;
  useEffect(()=>{
    const controller=new AbortController();let active=true;
    settings(id,undefined,controller.signal).then(value=>{if(active)setState(value);},e=>{if(active)setError(e.message);});
    return ()=>{active=false;controller.abort();};
  },[id,version,refresh]);
  async function save(change:HelpChange,success:string){
    setBusy(true);setError('');setNotice('');
    try{setState(await settings(id,change));setNotice(success);}
    catch(e){setError(e instanceof Error?e.message:'Could not confirm publication.');}
    finally{setBusy(false);}
  }
  const center=state?.center,pub=state?.publication,href=center?'/help/'+center.id:'';
  const message=<>{notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}{' '}
    <button type="button" onClick={()=>{setError('');setRefresh(n=>n+1);}}>Refresh</button></p>}</>;
  if(article){
    const visible=!!center?.enabled&&!!pub?.publishedRevision&&!article.archivedAt;
    return <section aria-label="Article publication"><h2>Publication</h2>
      {state&&<><p>{visible?'Published version '+pub?.publishedRevision:pub?.publishedRevision?'Help center is closed.':'Private draft'}
        {visible&&<> · <a href={href+'/'+id}>View public article</a></>}</p>
        {!center?.enabled&&<a href={portableArticlePath}>Manage help center</a>}
        {center?.enabled&&!article.archivedAt&&<PublishArticle key={pub?.revision??0} topic={pub?.topic??null}
          published={pub?.publishedRevision===article.revision} revision={article.revision} disabled={busy||Boolean(dirty)}
          onPublish={topic=>void save({action:'publish',id:article.id,topic,articleRevision:article.revision,
            revision:pub?.revision??0},pub?.publishedRevision===article.revision?'Public topic updated.':'Article published.')}/>}
        {pub?.publishedRevision&&<button type="button" disabled={busy} onClick={()=>void save({action:'withdraw',id:article.id,
          articleRevision:article.revision,revision:pub.revision},'Article withdrawn.')}>Withdraw article</button>}
      </>}{message}
    </section>;
  }
  return <details><summary>Public help center</summary>{message}
    {state&&<form key={String(center?.revision??0)} aria-label="Help center settings" onSubmit={event=>{
      event.preventDefault();const fields=new FormData(event.currentTarget);
      void save({action:'settings',revision:center?.revision??0,name:String(fields.get('name')),accent:String(fields.get('accent')),
        enabled:fields.has('enabled')},'Help center settings saved.');
    }}><fieldset disabled={busy}>
      <label>Help center name<input required name="name" maxLength={80} defaultValue={center?.name??''}/></label>
      <label>Brand color<input type="color" name="accent" defaultValue={center?.accent??'#17696b'}/></label>
      <label><input type="checkbox" name="enabled" defaultChecked={center?.enabled}/>Open the help center to the public</label>
      <p>Opening shows the versions you have published. Closing hides every article at its public link.</p>
      <button>Save help center settings</button>{center?.enabled&&<> · <a href={href}>Open public help center</a></>}
    </fieldset></form>}
  </details>;
}
