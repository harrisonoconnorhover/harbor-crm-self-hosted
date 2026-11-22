'use client';

import {useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import type {PortableCustomProperty} from '../lib/portable-custom-properties';
import {maxPipelineStages,portableStageProbability,portableDealStageFields,type DealPipeline,type PipelineStage} from '../lib/portable-deal-pipelines';

type DraftStage=Omit<PipelineStage,'id'|'probability'>&{id?:string;probability?:number};
type Draft={name:string;stages:DraftStage[]};

export function PortableDealFilterFields({pipelines,pipelineId,stage}:{
  pipelines:DealPipeline[];pipelineId?:string;stage?:string;
}){
  const [selected,setSelected]=useState(pipelineId??(stage?'default':''));
  const [filter,setFilter]=useState(stage??'');
  const options=pipelines.find(pipeline=>pipeline.id===selected)?.stages??[];
  return <>
    <label>Filter by pipeline<select name="pipelineId" value={selected} onChange={event=>{setSelected(event.target.value);setFilter('');}}>
      <option value="">All pipelines</option>
      {pipelines.map(pipeline=><option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
    </select></label>
    <label>Filter by stage<select name="stage" disabled={!selected} value={filter} onChange={event=>setFilter(event.target.value)}>
      <option value="">All stages</option>
      {options.map(option=><option key={option.id} value={option.id}>{option.name}</option>)}
    </select></label>
  </>;
}

export function PortableDealStage({pipelines,pipelineId,stage,stageEditable,existing}:{
  pipelines:DealPipeline[];pipelineId:string;stage?:string;stageEditable:boolean;existing:boolean;
}){
  const [selected,setSelected]=useState(pipelines.some(pipeline=>pipeline.id===pipelineId)?pipelineId:'default');
  const options=(pipelines.find(pipeline=>pipeline.id===selected)??pipelines[0]).stages;
  const fixedStage=existing&&stage?stage:options[0].id;
  return <>
    {!stageEditable&&existing&&<input type="hidden" name="pipelineId" value={selected}/>}
    {!stageEditable&&<input type="hidden" name="stageSelection" value={fixedStage}/>}
    <label>Deal pipeline<select disabled={!stageEditable&&existing} name="pipelineId" value={selected} onChange={event=>setSelected(event.target.value)}>
      {pipelines.map(pipeline=><option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
    </select></label>
    <label>Deal stage<select key={selected} name="stageSelection" disabled={!stageEditable} defaultValue={stageEditable?(selected===pipelineId?stage:undefined):fixedStage}>
      {options.map(option=><option key={option.id} value={option.id}>{option.name}</option>)}
    </select></label>
  </>;
}

const initialDraft=():Draft=>({name:'',stages:[
  {name:'Open',outcome:'open',probability:portableStageProbability('open')},
  {name:'Closed won',outcome:'won',probability:portableStageProbability('won')},
  {name:'Closed lost',outcome:'lost',probability:portableStageProbability('lost')},
]});

export function PortablePipelineSettings({pipelines,customProperties,initiallyOpen=false}:{pipelines:DealPipeline[];customProperties:PortableCustomProperty[];initiallyOpen?:boolean}){
  const requiredFields=portableDealStageFields(customProperties);
  const router=useRouter();
  const [draft,setDraft]=useState<Draft>();
  const [editing,setEditing]=useState<DealPipeline>();
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');

  function open(pipeline?:DealPipeline){
    setEditing(pipeline);
    setDraft(pipeline?{name:pipeline.name,stages:pipeline.stages}:initialDraft());
    setError('');
    setStatus('');
  }

  function updateStage(index:number,change:Partial<DraftStage>){
    setDraft(current=>current&&({...current,stages:current.stages.map((stage,position)=>position===index?{...stage,...change}:stage)}));
  }

  function move(from:number,to:number){
    setDraft(current=>{
      if(!current)return current;
      const stages=[...current.stages];
      const [stage]=stages.splice(from,1);
      stages.splice(to,0,stage);
      return {...current,stages};
    });
  }

  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    setSaving(true);
    setError('');
    try{
      const response=await fetch('/api/pipeline',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({...draft,...(editing?{id:editing.id,expectedRevision:editing.revision}:{})})});
      if(!response.ok){
        const result=await response.json() as {error?:string};
        setError(result.error||'Could not save the pipeline.');
        return;
      }
      setDraft(undefined);
      setStatus('Pipeline saved.');
      router.refresh();
    }catch{setError('Could not confirm the save. Refresh before trying again.');}
    finally{setSaving(false);}
  }

  return <details className="portable-pipeline-settings" open={initiallyOpen||undefined}>
    <summary>Deal pipeline settings</summary>
    <p><strong>Sales pipeline</strong> is built in. Add a pipeline to define your own stages.</p>
    <p>Start with an open stage and include at least one won and one lost stage.</p>
    <p>Stage probabilities determine the weighted amount for open deals in the pipeline summary.</p>
    <div className="portable-pipeline-stage-actions">
      <button type="button" disabled={saving} onClick={()=>open()}>Add pipeline</button>
      {pipelines.filter(pipeline=>pipeline.id!=='default').map(pipeline=>
        <button type="button" key={pipeline.id} disabled={saving} onClick={()=>open(pipeline)}>Edit {pipeline.name}</button>)}
    </div>
    {status&&<p role="status">{status}</p>}
    {draft&&<form className="portable-pipeline-editor" onSubmit={save}>
      <fieldset className="portable-pipeline-fields" disabled={saving}>
        <label>Pipeline name<input required maxLength={80} value={draft.name}
          onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
        <ol>{draft.stages.map((stage,index)=><li key={index}>
          <div className="portable-pipeline-stage-fields">
            <label>Stage {index+1} name<input required maxLength={80} value={stage.name}
              onChange={event=>updateStage(index,{name:event.target.value})}/></label>
            <label>Outcome<select value={stage.outcome} onChange={event=>{
              const outcome=event.currentTarget.value as DraftStage['outcome'];
              updateStage(index,{outcome,probability:portableStageProbability(outcome)});
            }}>
              <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option>
            </select></label>
            <label>Probability (%)<input type="number" min={0} max={100} step={1} required disabled={stage.outcome!=='open'}
              value={stage.probability??''} onChange={event=>updateStage(index,{
                probability:event.currentTarget.value===''?undefined:event.currentTarget.valueAsNumber,
              })}/></label>
          </div>
          <details>
            <summary>Required properties for {stage.name||'this stage'}</summary>
            <p>New deals and deals entering this stage need these values.</p>
            {requiredFields.map(field=><label key={field.id}>
              <input type="checkbox" checked={stage.requiredProperties?.some(item=>item.field===field.id)??false}
                onChange={event=>{
                  const prior=stage.requiredProperties??[];
                  updateStage(index,{requiredProperties:event.currentTarget.checked
                    ?[...prior,{field:field.id,required:true}]:prior.filter(item=>item.field!==field.id)});
                }}/>{field.label}
            </label>)}
          </details>
          <div className="portable-pipeline-stage-actions">
            <button type="button" disabled={index===0} onClick={()=>move(index,index-1)}>Move stage {index+1} up</button>
            <button type="button" disabled={index===draft.stages.length-1} onClick={()=>move(index,index+1)}>Move stage {index+1} down</button>
          </div>
        </li>)}</ol>
        <button type="button" disabled={draft.stages.length>=maxPipelineStages}
          onClick={()=>setDraft({...draft,stages:[...draft.stages,{name:'',outcome:'open',probability:portableStageProbability('open')}]})}>Add stage</button>
      </fieldset>
      {error&&<p role="alert">{error}</p>}
      <button type="submit" disabled={saving}>{saving?'Saving…':'Save pipeline'}</button>{' '}
      <button type="button" disabled={saving} onClick={()=>setDraft(undefined)}>Cancel</button>
    </form>}
  </details>;
}
