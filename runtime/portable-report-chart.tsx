'use client';

import {workspaceNumber} from '../lib/portable-account-defaults';
import {useWorkspaceDefaults} from './portable-workspace-format';
import {useState,type ReactNode} from 'react';
import {portableReportMetricLabel,type PortableReportDefinition,type PortableReportResult} from '../lib/portable-reports';
import './portable-report-chart.css';

const percent=new Intl.NumberFormat(undefined,{style:'percent',maximumFractionDigits:1});
const palette=['#116668','#b45137','#477ab3','#937139','#785f93','#397c52','#ac5379','#4c6979'];

export function ReportChart({definition,result,display,onOpenRecords,children}:{
  definition:PortableReportDefinition;result:PortableReportResult;display:(value:string|null)=>string;onOpenRecords?:(group?:string)=>void;children:ReactNode;
}){
  const defaults=useWorkspaceDefaults();
  const [view,setView]=useState<'table'|'bar'|'share'>(definition.chart??'table');
  if(!definition.groupBy||!result.rows.length)return children;
  // Reserve space to either side of zero when groups contain amounts of opposite signs.
  const values=result.rows.map(row=>Number(row.value));
  const min=Math.min(0,...values),max=definition.metric==='rate'?100:Math.max(0,...values),span=max-min||1;
  const zero=100*(-min/span);
  const sum=values.reduce((total,value)=>total+value,0);
  const canShare=(definition.metric==='count'||definition.metric==='sum')&&!result.truncated&&min===0&&sum>0&&values.length>=2&&values.length<=palette.length;
  const mode=view==='share'&&!canShare?'table':view;
  function label(row:PortableReportResult['rows'][number]){
    return onOpenRecords?<button className="report-chart-label" type="button" aria-label={'View records for '+row.label} onClick={()=>onOpenRecords(row.key??'')}>{row.label}</button>:<span>{row.label}</span>;
  }
  return <div className="portable-report-chart">
    <div className="report-chart-switch" role="group" aria-label="Report display">
      <button type="button" aria-pressed={mode==='table'} onClick={()=>setView('table')}>Table</button>
      <button type="button" aria-pressed={mode==='bar'} onClick={()=>setView('bar')}>Bar chart</button>
      {canShare&&<button type="button" aria-pressed={mode==='share'} onClick={()=>setView('share')}>Share of total</button>}
    </div>
    {mode==='table'?children:mode==='share'?<figure aria-label={definition.name+' share of total'}>
      <figcaption>Share of {definition.metric==='sum'?'total deal amount':'records'}</figcaption>
      <div className="report-chart-composition" aria-hidden="true">{values.map((value,index)=>
        <i key={index} style={{width:100*value/sum+'%',background:palette[index]}}/>)}</div>
      <ul>{result.rows.map((row,index)=><li className="report-chart-share" key={row.key===null?'missing':'group:'+row.key}>
        <i aria-hidden="true" style={{background:palette[index]}}/>{label(row)}<strong>{row.value===null?'—':defaults?workspaceNumber(values[index]/sum,defaults,'percent'):percent.format(values[index]/sum)}</strong>
      </li>)}</ul>
    </figure>:<figure aria-label={definition.name+' bar chart'}>
      <figcaption>{portableReportMetricLabel(definition.metric)} by group</figcaption>
      <ul>{result.rows.map((row,index)=>{
        const value=values[index],width=100*(Math.abs(value)/span);
        return <li key={row.key===null?'missing':'group:'+row.key}>
          {label(row)}
          <span className="report-chart-track" aria-hidden="true"><i style={{left:(value<0?zero-width:zero)+'%',width:width+'%'}}/></span>
          <strong>{display(row.value)}</strong>
        </li>;
      })}</ul>
    </figure>}
  </div>;
}
