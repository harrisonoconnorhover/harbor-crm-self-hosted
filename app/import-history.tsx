"use client";
import { useEffect, useState } from "react";
import type { Kind } from "@/lib/crm";
import type { ImportGroups } from "@/lib/import-conditions";

type ImportItem = {id:string;name:string;kind:Kind|null;mode:string|null;createdAt:string;membershipAvailable:boolean;result:{created:number;updated:number;skipped:number;associationsAdded?:number;associationsUpdated?:number}};
type Member = {id:string;name:string;kind:Kind;outcome:string};
function useImports(kind:Kind, query:string, page:number, id="", selected="", eligible=false) {
  const [retry,setRetry]=useState(0),[error,setError]=useState("");
  const key=JSON.stringify({kind,query,page,id,selected,eligible,retry});
  const [data,setData]=useState<{key:string;items:ImportItem[];members:Member[];item?:ImportItem;selected:ImportItem|null;total:number;page:number}|null>(null);
  useEffect(()=>{
    const controller=new AbortController();setError("");
    const timer=setTimeout(async()=>{try{
      const params=new URLSearchParams({kind,q:query,page:String(page),selected,eligible:eligible?"1":"0"});
      if(id)params.set("id",id);
      const res=await fetch(`/api/imports?${params}`,{signal:controller.signal,cache:"no-store"});
      const value=await res.json() as {items:ImportItem[]|Member[];item?:ImportItem;selected:ImportItem|null;total:number;page:number;error?:string};if(!res.ok)throw Error(value.error||"Could not load imports.");
      if(!controller.signal.aborted)setData({...value,members:id?value.items as Member[]:[],items:id?[]:value.items as ImportItem[],key});
    }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:"Could not load imports.");}},150);
    return()=>{clearTimeout(timer);controller.abort();};
  },[key,kind,query,page,id,selected,eligible]);
  return {data:data?.key===key?data:null,error,reload:()=>setRetry(v=>v+1)};
}
function Pager({page,total,onChange}:{page:number;total:number;onChange:(page:number)=>void}) {
  return <div className="wf-buttons"><button disabled={!page} onClick={()=>onChange(page-1)}>Previous imports page</button><span>{page+1} / {Math.max(1,Math.ceil(total/25))}</span><button disabled={(page+1)*25>=total} onClick={()=>onChange(page+1)}>Next imports page</button></div>;
}
function ImportPicker({kind,value,onChange}:{kind:Kind;value:string;onChange:(value:string)=>void}) {
  const [query,setQuery]=useState(""),[page,setPage]=useState(0);
  const {data,error,reload}=useImports(kind,query,page,"",value,true);
  return <details className="segment-picker"><summary>{value ? data ? data.selected?.name||"Import unavailable" : "Loading selected import…" : "Choose import"}</summary>
    <input aria-label="Search imports for condition" placeholder="Search imports…" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/>
    {error?<p role="alert">{error} <button onClick={reload}>Retry</button></p>:!data?<p role="status">Loading imports…</p>:<>
      {!data.items.length&&<p>No matching imports with recorded membership for this object.</p>}
      <div className="segment-picker-options">{data.items.map(item=><button key={item.id} aria-pressed={value===item.id} onClick={e=>{onChange(item.id);e.currentTarget.closest("details")?.removeAttribute("open");}}>{item.name}<small>{new Date(item.createdAt).toLocaleString()}</small></button>)}</div>
      <Pager page={data.page} total={data.total} onChange={setPage}/></>}
  </details>;
}
export function ImportGroupsEditor({kind,groups,onChange}:{kind:Kind;groups:ImportGroups;onChange:(groups:ImportGroups)=>void}) {
  return <section className="workflow-activity-criteria"><h3>Import membership</h3>
    <p>Match any import group below, AND the other filters. Each requirement within a group must match. New imports track created, updated and unchanged matched records; skipped duplicates and unmatched rows are excluded.</p>
    {groups.map((group,gi)=><section className="filter-group" key={gi}>{gi>0&&<strong>OR</strong>}<h4>Match ALL in import group {gi+1}</h4>
      {group.map((rule,ri)=><div className="filter-group" key={ri}><select aria-label={`Import membership ${gi+1}.${ri+1}`} value={rule.mode} onChange={e=>onChange(groups.map((g,i)=>i===gi?g.map((r,j)=>j===ri?{...r,mode:e.target.value as "in"|"not_in"}:r):g))}><option value="in">Is in import</option><option value="not_in">Is not in import</option></select>
        <ImportPicker kind={kind} value={rule.importId} onChange={importId=>onChange(groups.map((g,i)=>i===gi?g.map((r,j)=>j===ri?{...r,importId}:r):g))}/>
        <button className="text-button" onClick={()=>onChange(groups.map((g,i)=>i===gi?g.filter((_,j)=>j!==ri):g))}>Remove import requirement {gi+1}.{ri+1}</button></div>)}
      <button disabled={group.length>=10} onClick={()=>onChange(groups.map((g,i)=>i===gi?[...g,{importId:"",mode:"in"}]:g))}>Add AND import requirement</button>
      <button className="text-button" onClick={()=>onChange(groups.filter((_,i)=>i!==gi))}>Remove import group {gi+1}</button>
    </section>)}
    <button className="secondary" disabled={groups.length>=10} onClick={()=>onChange([...groups,[{importId:"",mode:"in"}]])}>{groups.length?"Add OR import group":"Add import group"}</button>
  </section>;
}
export function ImportHistory({kind,initialId="",onBack,onClose}:{kind:Kind;initialId?:string;onBack:()=>void;onClose:()=>void}) {
  const [id,setId]=useState(initialId),[query,setQuery]=useState(""),[page,setPage]=useState(0);
  const {data,error,reload}=useImports(kind,query,page,id);
  const [name,setName]=useState(""),[mode,setMode]=useState<"active"|"static">("active"),[busy,setBusy]=useState(false),[saveError,setSaveError]=useState(""),[saved,setSaved]=useState(false);
  const [segmentId,setSegmentId]=useState(()=>crypto.randomUUID());
  function select(value:string,defaultName="") {setId(value);setName(defaultName.slice(0,120));setQuery("");setPage(0);setSaveError("");setSaved(false);setSegmentId(crypto.randomUUID());}
  return <section className="import-history"><div className="wf-buttons"><button disabled={busy} onClick={id?()=>select(""):onBack}>{id?"Back to import history":"New import"}</button></div>
    <h2>{data?.item?.name||"Import history"}</h2>
    <p>Original totals are retained. Members below reflect records still present; deleting or merging away a record removes it from this import's current membership. Imports before tracking was introduced may have no membership history.</p>
    <input aria-label={id?"Search import members":"Search import history"} placeholder={id?"Search records…":"Search imports…"} value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/>
    {error?<p role="alert">{error} <button onClick={reload}>Retry</button></p>:!data?<p role="status">Loading import history…</p>:<>
      {data.item&&<p>{new Date(data.item.createdAt).toLocaleString()} · {data.item.result.created} created · {data.item.result.updated} updated · {data.item.result.skipped} skipped{data.item.result.associationsAdded || data.item.result.associationsUpdated ? ` · ${data.item.result.associationsAdded || 0} associations added · ${data.item.result.associationsUpdated || 0} labels updated` : ""}</p>}
      {data.item&&!data.item.membershipAvailable?<p>Membership was not recorded for this older import.</p>:id?<>
        <p>{data.total} matching current members. Unchanged matched rows count as skipped in the original totals.</p>
        <table><thead><tr><th>Record</th><th>Import outcome</th></tr></thead><tbody>{data.members.map(member=><tr key={member.id}><td><a href={`#${member.kind}/${member.id}`} onClick={onClose}>{member.name}</a></td><td>{member.outcome}</td></tr>)}</tbody></table>
        {!data.members.length&&<p>No matching records.</p>}
      </>:<><table><thead><tr><th>Import</th><th>Date</th><th>Created</th><th>Updated</th><th>Skipped</th></tr></thead><tbody>{data.items.map(item=><tr key={item.id}><td>{item.membershipAvailable?<button className="text-button" onClick={()=>select(item.id,item.name)}>{item.name}</button>:<>{item.name}<small> · Object and membership unavailable</small></>}</td><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.result.created}</td><td>{item.result.updated}</td><td>{item.result.skipped}</td></tr>)}</tbody></table>{!data.items.length&&<p>No imports recorded yet.</p>}</>}
      <Pager page={data.page} total={data.total} onChange={setPage}/>
      {data.item?.membershipAvailable&&<section className="filter-group"><h3>Create segment from this import</h3><p>This uses all current import members, regardless of the search or page above.</p>
        <label className="form-field">Segment name<input maxLength={120} value={name} onChange={e=>setName(e.target.value)} disabled={busy||saved}/></label>
        <label className="form-field">Segment type<select value={mode} disabled={busy||saved} onChange={e=>setMode(e.target.value as "active"|"static")}><option value="active">Active — combine with other filters later</option><option value="static">Static — snapshot of current members</option></select></label>
        {saveError&&<p role="alert">{saveError}</p>}
        {saved?<p role="status">Segment created. <a href="#segments" onClick={onClose}>Open segments</a></p>:<button className="primary" disabled={busy||!name.trim()} onClick={async()=>{setBusy(true);setSaveError("");try {
          const res=await fetch("/api/segments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"save",segment:{id:segmentId,revision:0,name:name.trim(),kind,mode,criteria:{groups:[],importGroups:[[{importId:id,mode:"in"}]]}}})});
          const value=await res.json() as {error?:string};if(!res.ok)throw Error(value.error||"Could not create segment.");setSaved(true);
        }catch(e){setSaveError(e instanceof Error?e.message:"Could not create segment.");}finally{setBusy(false);}}}>{busy?"Creating…":"Create segment"}</button>}
      </section>}
    </>}
  </section>;
}
