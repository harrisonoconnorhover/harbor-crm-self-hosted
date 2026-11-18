import type {DealPipeline} from '../lib/portable-deal-pipelines';
import type {DealStageTotals} from '../lib/portable-records';

export type DealSummaryData={pipeline:DealPipeline;totals:DealStageTotals[]};
const amountFormat=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const outcomes={open:'Open',won:'Won',lost:'Lost'};

export function PortableDealSummary({summary,pipelines,workspaceId,closeMonth}:{
  summary:DealSummaryData;pipelines:DealPipeline[];workspaceId?:string;closeMonth?:string;
}){
  const {pipeline,totals}=summary;
  const byStage=new Map(totals.map(row=>[row.stageId,row]));
  const total=byStage.get(null);
  function summaryLink(month?:string){
    const query=new URLSearchParams({kind:'deals',view:'summary',pipelineId:pipeline.id});
    if(workspaceId)query.set('workspaceId',workspaceId);
    if(month)query.set('closeMonth',month);
    return '/?'+query;
  }
  function stageLink(stage:string){
    const query=new URLSearchParams({kind:'deals',pipelineId:pipeline.id,stage});
    if(workspaceId)query.set('workspaceId',workspaceId);
    if(closeMonth)query.set('closeMonth',closeMonth);
    return '/?'+query;
  }
  return <section aria-labelledby="portable-summary-title">
    <h2 id="portable-summary-title">{pipeline.name} summary</h2>
    <p>Weighted open amounts multiply each open deal’s saved amount by its stage probability. Closed deals still count toward the Amount total.</p>
    <form action="/" method="get" aria-label="Pipeline summary filters">
      <input name="kind" type="hidden" value="deals"/>
      <input name="view" type="hidden" value="summary"/>
      {workspaceId&&<input name="workspaceId" type="hidden" value={workspaceId}/>}
      <label>Pipeline<select name="pipelineId" defaultValue={pipeline.id}>
        {pipelines.map(option=><option key={option.id} value={option.id}>{option.name}</option>)}
      </select></label>
      <label>Close month<input name="closeMonth" type="month" min="0001-01" max="9999-12"
        defaultValue={closeMonth==='undated'?undefined:closeMonth}/></label>
      <button type="submit">Show summary</button>
    </form>
    <nav aria-label="Close date shortcuts">
      <a href={summaryLink()} aria-current={!closeMonth?'page':undefined}>All close dates</a>
      <a href={summaryLink('undated')} aria-current={closeMonth==='undated'?'page':undefined}>No close date</a>
    </nav>
    <p>{closeMonth==='undated'?'Deals without a close date':closeMonth?'Deals closing in '+closeMonth:'Deals across all close dates'}</p>
    <div className="portable-contacts-table"><table>
      <thead><tr><th scope="col">Stage</th><th scope="col">Outcome</th><th scope="col">Deals</th><th scope="col">Amount</th>
        <th scope="col">Probability</th><th scope="col">Weighted open</th></tr></thead>
      <tbody>{pipeline.stages.map(stage=>{
        const row=byStage.get(stage.id);
        return <tr key={stage.id}><th scope="row"><a href={stageLink(stage.id)}>{stage.name}</a></th>
          <td>{outcomes[stage.outcome]}</td><td>{row?.dealCount??0}</td><td>{amountFormat.format(row?.amount??0)}</td>
          <td>{stage.probability}%</td><td>{stage.outcome==='open'?amountFormat.format(row?.weightedOpen??0):'—'}</td></tr>;
      })}</tbody>
      <tfoot><tr><th scope="row" colSpan={2}>Total</th><td>{total?.dealCount??0}</td><td>{amountFormat.format(total?.amount??0)}</td>
        <td>—</td><td>{amountFormat.format(total?.weightedOpen??0)}</td></tr></tfoot>
    </table></div>
  </section>;
}
