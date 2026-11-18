'use client';

import {useState,type FormEvent} from 'react';
import {portableContactSort,type PortableRecordKind} from '../lib/portable-records';
import {portableDefaultRecordListColumns} from '../lib/portable-record-list-columns';
import {portableSavedViewColumnLimit,portableSavedViewPath,type PortableSavedView,type PortableSavedViewFilters,type PortableSavedViewWrite} from '../lib/portable-saved-views';

type Props={
  kind:PortableRecordKind;
  views:PortableSavedView[];
  activeId?:string;
  workspaceId?:string;
  // An editor's grant in a shared workspace; editors can save and change their own views.
  grantId?:string;
  // Ordering by Last contacted needs the shared outreach permission.
  outreach?:boolean;
  filters:PortableSavedViewFilters;
  columnCatalog:readonly {id:string;label:string}[];
};

export function PortableSavedViews({kind,views,activeId,workspaceId,grantId,outreach=true,filters,columnCatalog:catalog}:Props){
  const editableViews=workspaceId?views.filter(view=>view.mine):views;
  const [targetId,setTargetId]=useState(activeId&&editableViews.some(view=>view.id===activeId)?activeId:'');
  const active=views.find(view=>view.id===activeId);
  const [name,setName]=useState(active?.name??'');
  const [sort,setSort]=useState(filters.sort);
  const [columns,setColumns]=useState<string[]|null>(active?.columns??null);
  const [columnToAdd,setColumnToAdd]=useState('');
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const target=editableViews.find(view=>view.id===targetId);
  const scope=workspaceId&&grantId?'?'+new URLSearchParams({workspaceId,grantId}):'';
  const selectedColumns=columns?.filter(id=>catalog.some(column=>column.id===id))??
    portableDefaultRecordListColumns(kind).map(column=>column.id);
  const availableColumns=selectedColumns.length<portableSavedViewColumnLimit?
    catalog.filter(column=>!selectedColumns.includes(column.id)):[];
  const path=(id?:string)=>portableSavedViewPath(kind,id,undefined,workspaceId);
  const unfiltered=!activeId&&!Object.values(filters).some(Boolean);

  async function submit(action:PortableSavedViewWrite){
    setPending(true);
    setError('');
    try{
      const response=await fetch('/api/crm/views'+scope,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action)});
      const result=await response.json() as {view?:PortableSavedView;deleted?:boolean;error?:string};
      if(!response.ok)throw Error(result.error??'Could not save your view.');
      if(result.view)window.location.assign(path(result.view.id));
      else if(result.deleted&&action.action==='delete'){
        window.location.assign(path(activeId===action.id?undefined:activeId));
      }else throw Error('Could not confirm your saved view change.');
    }catch(error){
      setError(error instanceof Error?error.message:'Could not save your view.');
      setPending(false);
    }
  }

  function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const definition={kind,name,filters:{...filters,sort:outreach?sort:undefined},columns:columns===null?null:selectedColumns};
    if(target)void submit({action:'update',id:target.id,expectedRevision:target.revision,...definition});
    else void submit({action:'create',...definition});
  }

  function moveColumn(index:number,offset:-1|1){
    const next=[...selectedColumns];
    [next[index],next[index+offset]]=[next[index+offset],next[index]];
    setColumns(next);
  }

  return <>
    <nav aria-label={workspaceId?"Shared saved views":"Saved views"}>
      <a href={path()} aria-current={unfiltered?'page':undefined}>All records</a>
      {views.map(view=><a key={view.id} href={path(view.id)}
        aria-current={view.id===activeId?'page':undefined}>{view.name}{!workspaceId&&view.shared?' (Shared)':''}{view.author?' · by '+view.author:''}</a>)}
    </nav>
    {(!workspaceId||grantId)&&<details>
      <summary>Manage saved views</summary>
      <p>{workspaceId?'Apply your list filters and choose columns before saving. Views you save here are shared with the workspace and you can change them later.':
        'Apply your list filters and choose columns before saving. Shared views appear in this workspace for its current members.'}</p>
      <form onSubmit={save}>
        <fieldset disabled={pending}>
          <label>Save current filters to
            <select value={targetId} onChange={event=>{
              const id=event.currentTarget.value;
              setTargetId(id);
              const view=editableViews.find(item=>item.id===id);
              setName(view?.name??'');
              setSort(view?.filters.sort??(view?undefined:filters.sort));
              setColumns(view?.columns??null);
              setColumnToAdd('');
              setError('');
            }}>
              <option value="">New view</option>
              {editableViews.map(view=><option key={view.id} value={view.id}>{view.name}</option>)}
            </select>
          </label>
          <label>View name <input value={name} onChange={event=>setName(event.currentTarget.value)} maxLength={80} required/></label>
          {kind==='contacts'&&outreach&&<label>Order by
            <select value={sort??''} onChange={event=>{
              const next=portableContactSort.safeParse(event.currentTarget.value);
              setSort(next.success?next.data:undefined);
            }}>
              <option value="">Default order</option>
              <option value="outreach-newest">Last contacted, newest first</option>
              <option value="outreach-oldest">Last contacted, oldest first</option>
            </select>
          </label>}
          <fieldset className="portable-saved-view-columns">
            <legend>Table columns</legend>
            <ol>
              {selectedColumns.map((id,index)=>{
                const column=catalog.find(item=>item.id===id);
                if(!column)return null;
                return <li key={id}>{column.label}{id==='name'?' (pinned)':<>
                  <button type="button" aria-label={'Move '+column.label+' up'} disabled={index===1} onClick={()=>moveColumn(index,-1)}>Move up</button>
                  <button type="button" aria-label={'Move '+column.label+' down'} disabled={index===selectedColumns.length-1} onClick={()=>moveColumn(index,1)}>Move down</button>
                  <button type="button" aria-label={'Remove '+column.label} onClick={()=>setColumns(selectedColumns.filter(item=>item!==id))}>Remove</button>
                </>}</li>;
              })}
            </ol>
            <div className="portable-saved-view-column-actions">
              <label>Add a column
                <select value={columnToAdd} disabled={!availableColumns.length} onChange={event=>setColumnToAdd(event.currentTarget.value)}>
                  <option value="">Choose a column</option>
                  {availableColumns.map(column=><option key={column.id} value={column.id}>{column.label}</option>)}
                </select>
              </label>
              <button type="button" disabled={!availableColumns.some(column=>column.id===columnToAdd)} onClick={()=>{
                setColumns([...selectedColumns,columnToAdd]);
                setColumnToAdd('');
              }}>Add column</button>
              <button type="button" disabled={columns===null} onClick={()=>{
                setColumns(null);
                setColumnToAdd('');
              }}>Reset columns</button>
            </div>
          </fieldset>
          <button type="submit">{target?'Update view':'Save view'}</button>
          {target&&<button type="button" onClick={()=>void submit({action:'delete',kind,id:target.id,expectedRevision:target.revision})}>Delete view</button>}
          {target&&!workspaceId&&!target.author&&<button type="button" onClick={()=>void submit({action:'setSharing',kind,id:target.id,
            expectedRevision:target.revision,shared:!target.shared})}>{target.shared?'Make private':'Share with workspace'}</button>}
        </fieldset>
        {error&&<p role="alert">{error}</p>}
      </form>
    </details>}
  </>;
}
