'use client';

import {useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {Building2,CalendarDays} from 'lucide-react';
import type {DealPipeline,MissingDealStageField,PipelineStage} from '../lib/portable-deal-pipelines';
import type {DealRecord,PortableDealLane,PortableRecordQuery} from '../lib/portable-records';

export type DealBoardData={pipeline:DealPipeline;lanes:PortableDealLane[]};
export type BlockedDealMove={stageId:string;missingFields:MissingDealStageField[];message:string};

export function PortableDealBoard({board,filters,workspaceId,grantId,readOnly,onEdit}:{
  board:DealBoardData;filters:Pick<PortableRecordQuery,'search'|'owner'|'closeMonth'>;workspaceId?:string;grantId?:string;readOnly:boolean;
  onEdit:(record:DealRecord,move?:BlockedDealMove)=>void;
}){
  const router=useRouter();
  const {pipeline,lanes}=board;
  const [dragged,setDragged]=useState<DealRecord|null>(null);
  const [pending,setPending]=useState(false);
  const [status,setStatus]=useState('');
  const [error,setError]=useState('');
  const [blockedMove,setBlockedMove]=useState<{card:DealRecord;intent:BlockedDealMove}>();
  const moving=useRef(false);
  const stageFor=(card:DealRecord)=>card.stageId??card.data.stage;

  function stageList(stage:string){
    const params=new URLSearchParams({kind:'deals',pipelineId:pipeline.id,stage});
    for(const [key,value] of Object.entries({workspaceId,...filters}))if(value)params.set(key,value);
    return '/?'+params;
  }

  async function move(card:DealRecord,stage:PipelineStage){
    if(readOnly||moving.current||stageFor(card)===stage.id)return;
    moving.current=true;
    setPending(true);
    setStatus('');
    setError('');
    setBlockedMove(undefined);
    try{
      const scope=workspaceId&&grantId?'?'+new URLSearchParams({workspaceId,grantId}):'';
      const data={...card.data,stage:stage.name};
      delete data.recordOwner;
      const response=await fetch('/api/crm'+scope,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'save',kind:'deals',id:card.id,expectedRevision:card.revision,
          data,stageId:pipeline.id==='default'?null:stage.id})});
      if(!response.ok){
        const result=await response.json() as {error?:string;fields?:MissingDealStageField[]};
        const message=result.error||'Could not move this deal.';
        setError(message);
        if(result.fields?.length)setBlockedMove({card,intent:{stageId:stage.id,missingFields:result.fields,message}});
        return;
      }
      setStatus(card.data.name+' moved to '+stage.name+'.');
      router.refresh();
    }catch{setError('Could not confirm the move. Refresh the board to check.');}
    finally{
      moving.current=false;
      setPending(false);
    }
  }

  function submit(event:FormEvent<HTMLFormElement>,card:DealRecord){
    event.preventDefault();
    const destination=new FormData(event.currentTarget).get('destination');
    const stage=pipeline.stages.find(item=>item.id===destination);
    if(stage)void move(card,stage);
  }

  return <>
    {!readOnly&&<p className="portable-deal-board-help">Drag deals between stages or use Move.</p>}
    <p className="portable-deal-board-status" role="status">{status}</p>
    {error&&<p role="alert">{error}{' '}
      {blockedMove?<button type="button" onClick={()=>{
        onEdit(blockedMove.card,blockedMove.intent);
        setBlockedMove(undefined);
        setError('');
      }}>Open deal to complete properties</button>:
        <button type="button" onClick={()=>{setError('');router.refresh();}}>Refresh board</button>}</p>}
    <div className="portable-deal-board" role="region" aria-label={pipeline.name+' board'} tabIndex={0}>
      {lanes.map(({stage,cards,more})=><section key={stage.id} aria-label={stage.name}
        className="portable-deal-lane" data-outcome={stage.outcome}
        onDragOver={event=>{if(dragged&&!pending&&stageFor(dragged)!==stage.id)event.preventDefault();}}
        onDrop={event=>{
          if(!dragged)return;
          event.preventDefault();
          setDragged(null);
          void move(dragged,stage);
        }}>
        <header className="portable-deal-lane-heading">
          <h2>{stage.name}</h2>
          <span className="portable-deal-lane-count">
            {cards.length}{more?'+':''} {cards.length===1&&!more?'deal':'deals'}
          </span>
        </header>
        {cards.length>0&&<ul>{cards.map(card=><li key={card.id} className="portable-deal-card"
          draggable={!readOnly&&!pending}
          onDragStart={event=>{
            event.dataTransfer.setData('text/plain',card.id);
            event.dataTransfer.effectAllowed='move';
            setDragged(card);
          }}
          onDragEnd={()=>setDragged(null)}>
          {readOnly?<a className="portable-deal-card-title" href={'/?'+new URLSearchParams({
            kind:'deals',record:card.id,...(workspaceId?{workspaceId}:{}),
          })}>{card.data.name}</a>:<button type="button" className="portable-deal-card-title"
            disabled={pending} onClick={()=>onEdit(card)}>{card.data.name}</button>}
          <p className="portable-deal-card-amount">{card.data.amount.toLocaleString()}</p>
          {card.companyName&&<p className="portable-deal-card-meta"><Building2 size={14} aria-hidden="true"/>{card.companyName}</p>}
          {card.data.closeDate&&<p className="portable-deal-card-meta"><CalendarDays size={14} aria-hidden="true"/>
            <span>Closes <time dateTime={card.data.closeDate}>{card.data.closeDate}</time></span></p>}
          {!readOnly&&<form onSubmit={event=>submit(event,card)}>
            <select name="destination" aria-label={'Move '+card.data.name+' to stage'} disabled={pending}
              key={card.revision} defaultValue={stage.id}>
              {pipeline.stages.map(option=><option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
            <button type="submit" disabled={pending}>Move</button>
          </form>}
        </li>)}</ul>}
        {!cards.length&&<p className="portable-deal-lane-empty">No deals in this stage.</p>}
        {more&&<a href={stageList(stage.id)}>View all deals in {stage.name}</a>}
      </section>)}
    </div>
  </>;
}
