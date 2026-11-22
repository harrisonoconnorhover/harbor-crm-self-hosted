import {objectPath} from '../lib/portable-custom-objects';
import {WorkspaceNumber} from './portable-workspace-format';

type Results={workspaceId?:string;objectId:string;by?:string;sumId?:string;fieldLabel?:string;total:number;sumLabel?:string;sum?:string|null;
  groups:{value:string|null;label:string;count:number;sum?:string|null}[]};

function amount(value:string|null|undefined){
  return value==null?'—':<WorkspaceNumber value={value}>{value}</WorkspaceNumber>;
}

export function CustomReportResults({workspaceId,objectId,by,sumId,fieldLabel,total,sumLabel,sum,groups}:Results){
  return <>
    <p><strong><WorkspaceNumber value={total}/></strong> active {total===1?'record':'records'}</p>
    {sumLabel&&<p>Total {sumLabel}: <strong>{amount(sum)}</strong></p>}
    {fieldLabel&&groups.length>0&&<table aria-label={fieldLabel+' breakdown'}>
      <thead><tr><th scope="col">{fieldLabel}</th><th scope="col">Records</th>{sumLabel&&<th scope="col">Total {sumLabel}</th>}</tr></thead>
      <tbody>{groups.map(row=><tr key={JSON.stringify(row.value)}>
        <th scope="row"><a href={objectPath({workspaceId,objectId,by,sum:sumId,value:row.value??''})}>{row.label}</a></th>
        <td><WorkspaceNumber value={row.count}/></td>{sumLabel&&<td>{amount(row.sum)}</td>}
      </tr>)}</tbody>
    </table>}
  </>;
}
