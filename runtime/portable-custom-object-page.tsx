import {CustomReportResults} from './portable-custom-report-results';
import {WorkspaceDate,WorkspaceNumber} from './portable-workspace-format';
import {effectiveMemberToolPolicy} from '../lib/portable-tool-permissions';
import {portablePageHasBody} from './portable-page-body';
import {notFound} from 'next/navigation';
import {readObjects} from '../db/postgres/custom-object-store';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {portableWorkspaceAssignees} from '../db/postgres/workspace-assignee-store';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {ApiError} from '../lib/api-error';
import {portableRecordPath} from '../lib/portable-record-path';
import {isReportField,objectPath,objectRead,reportValueLabel} from '../lib/portable-custom-objects';
import {propertyText} from '../lib/workspace';
import {portableWorkspaceGuest} from './portable-identity';
import {portableLoginConfig} from './portable-login-config';
import {portableDb} from './portable-db';
import {env} from './portable-env';
import {PortableCrmHeader} from './portable-crm-header';
import {AddObjectReportToDashboard} from './portable-dashboards-ui';
import {CustomObjectImport} from './portable-custom-object-import';
import {CustomRecordActions,CustomRecordEditor,ObjectDesigner} from './portable-custom-object-ui';

export async function CustomObjectPage({input,user}:{input:Record<string,string|undefined>;user:{userId:string;email:string}}){
  const {view,mode,back,...params}=input;
  if(back!==undefined&&(back!=='unavailable'||!params.record))notFound();
  const parsed=objectRead.safeParse(params);
  if(view!=='custom-objects'||params.preview!==undefined||!parsed.success||mode&&(!['settings','create','edit','import'].includes(mode)||params.summary||params.by))notFound();
  const db=portableDb(),q=parsed.data,workspaceId=q.workspaceId;
  if(portableWorkspaceGuest(user.email)&&(!workspaceId||!await guestWorkspaceAllowed(db,user.userId,workspaceId,portableLoginConfig(env).allowedEmails)))notFound();
  const grant=workspaceId?await sharedWorkspaceGrant(db,user.userId,workspaceId,true):undefined;
  const policy=grant&&effectiveMemberToolPolicy(grant,'custom-objects');
  if(workspaceId&&(!policy||policy.view==='none'))notFound();
  const shared=workspaceId&&grant?{workspaceId,grantId:grant.id}:undefined;
  const editorPage=mode==='edit'&&Boolean(q.record);
  const auditEmail=(!mode||editorPage)&&await portablePageHasBody()?user.email:undefined;
  const result=await readObjects(db,user.userId,q,auditEmail,editorPage).catch(err=>{if(err instanceof ApiError&&err.status===404)notFound();throw err;});
  const root=objectPath({workspaceId,summary:q.summary,owner:q.owner??back}),list=objectPath({workspaceId,objectId:q.objectId,owner:q.owner??back});
  function accessHistoryPath(objectId:string,record?:string){
    const filters=new URLSearchParams({view:'record-access',kind:'custom-objects',objectId});
    if(record)filters.set('record',record);
    return '/?'+filters;
  }
  const heading=result.view==='record'?result.record.name:result.view==='summary'?result.type.definition.name+' report':result.view==='list'?result.type.definition.name:
    q.summary?'Custom object reports':q.owner?'Custom records with unavailable owners':
    result.view==='related'?'Linked custom records':'Custom objects';
  let body;
  if(mode==='settings'){
    if(shared||result.view!=='types'&&result.view!=='list')notFound();
    const existing=result.view==='list'?result.type:undefined;
    body=<ObjectDesigner existing={existing} id={existing?.id??crypto.randomUUID()}/>;
  }else if(mode==='import'){
    if(shared||result.view!=='list')notFound();
    body=<CustomObjectImport type={result.type} list={list}/>;
  }else if(mode==='create'||mode==='edit'){
    if(result.view!=='list'&&result.view!=='record'||(mode==='create'?result.view!=='list'||!result.canCreate:
      result.view!=='record'||!result.record.editable||result.record.archivedAt))notFound();
    const current=result.view==='record'?result.record:undefined;
    const assignees=await portableWorkspaceAssignees(db,user.userId,workspaceId,undefined,'custom-objects');
    body=<CustomRecordEditor handoff={back==='unavailable'} type={result.type} current={current} id={current?.id??crypto.randomUUID()} shared={shared} assignees={assignees} restrictedActor={policy&&policy.edit!=='all'?user.userId:undefined}/>;
  }else if(result.view==='record'){
    const {type,record}=result;
    body=<>{record.archivedAt&&<p>Archived</p>}
      {record.editable&&!record.archivedAt&&<a href={objectPath({...params,back,mode:'edit'})}>{back?'Reassign record':'Edit record'}</a>}
      <dl><dt>Record owner</dt><dd>{record.data.recordOwner?.label??'Unassigned'}</dd>
        {type.definition.fields.map(field=>{
          const value=record.data.values[field.id],text=propertyText(value)||'—';
          let display;
          if(typeof value==='number'&&field.type==='number')display=<WorkspaceNumber value={value}>{text}</WorkspaceNumber>;
          else if(typeof value==='string'&&(field.type==='date'||field.type==='datetime')){
            display=<time dateTime={value}><WorkspaceDate value={value} day={field.type==='date'}>{text}</WorkspaceDate></time>;
          }
          return <div key={field.id}><dt>{field.label}</dt><dd>{display??text}</dd></div>;
        })}</dl>
      {(result.followUps.length>0||q.afterTask)&&<section id="workflow-tasks" aria-label="Workflow tasks"><h2>Workflow tasks</h2>
        <ul>{result.followUps.map(task=><li key={task.id}><a href={portableRecordPath('tasks',task.id,workspaceId)}>{task.name}</a>
          {' · '}{task.completedAt?'Completed':'Open'}</li>)}</ul>
        {q.afterTask&&<a href={objectPath({...params,afterTask:undefined,afterTaskAt:undefined})+'#workflow-tasks'}>Newest workflow tasks</a>}{' '}
        {result.nextTasks&&<a href={objectPath({...params,afterTask:result.nextTasks.id,afterTaskAt:String(result.nextTasks.at)})+'#workflow-tasks'}>Older workflow tasks</a>}
      </section>}
      {!shared&&<p><a href={accessHistoryPath(type.id,record.id)}>View record access history</a> · <a href={'/?'+new URLSearchParams({view:'workflows',runObjectId:type.id,runCustomRecordId:record.id})+'#recent-runs'}>View record workflow runs</a></p>}
      <CustomRecordActions canDelete={policy?.delete!==false} detail={result} shared={shared} after={q.after} afterCustom={q.afterCustom}/></>;
  }else if(result.view==='summary'){
    const fields=result.type.definition.fields.filter(isReportField);
    const field=fields.find(f=>f.id===q.by);
    const measures=result.type.definition.fields.filter(f=>f.type==='number');
    const measure=measures.find(f=>f.id===q.sum);
    body=<>{(fields.length>0||measures.length>0)&&<form method="get"><input type="hidden" name="view" value="custom-objects"/>
        <input type="hidden" name="summary" value="1"/><input type="hidden" name="objectId" value={q.objectId}/>
        {workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
        {fields.length>0&&<><label htmlFor="object-group">Group by</label> <select id="object-group" name="by" defaultValue={q.by??''}>
          <option value="">All records</option>{fields.map(f=><option key={f.id} value={f.id}>{f.label}</option>)}</select></>}
        {measures.length>0&&<label>Total numeric field <select name="sum" defaultValue={q.sum??''}>
          <option value="">Count records only</option>{measures.map(f=><option key={f.id} value={f.id}>{f.label}</option>)}
        </select></label>} <button>Apply</button></form>}
      <CustomReportResults workspaceId={workspaceId} objectId={result.type.id} by={field?.id} fieldLabel={field?.label}
        total={result.total} sumId={measure?.id} sumLabel={measure?.label} sum={result.sum}
        groups={field?result.groups.map(row=>({...row,label:reportValueLabel(field,row.value)})):[]}/>
      <p><a href={list}>View records</a></p>
      {!shared&&<AddObjectReportToDashboard objectId={result.type.id} by={field?.id} sum={measure?.id}/>}</>;
  }else if(result.view==='list'){
    const field=result.type.definition.fields.find(f=>f.id===q.by);
    const exportParams=new URLSearchParams({export:'csv',objectId:result.type.id});
    if(q.owner)exportParams.set('owner',q.owner);
    if(q.archived)exportParams.set('archived',q.archived);
    if(q.search)exportParams.set('search',q.search);
    if(field&&q.value!==undefined){exportParams.set('by',field.id);exportParams.set('value',q.value);}
    body=<>{result.canCreate&&<a href={objectPath({workspaceId,objectId:q.objectId,mode:'create'})}>Add record</a>}{!shared&&<> · <a href={objectPath({objectId:q.objectId,mode:'settings'})}>Object settings</a> · <a href={objectPath({objectId:q.objectId,mode:'import'})}>Import CSV</a></>}
      <p><a href={objectPath({workspaceId,objectId:q.objectId,summary:'1',by:q.by,sum:q.sum})}>Object report</a>
        {!shared&&<> · <a href={'/api/custom-objects?'+exportParams} download>Export CSV</a> · <a href={accessHistoryPath(result.type.id)}>View object access history</a></>}</p>
      <p><a href={objectPath({workspaceId,objectId:q.objectId,owner:q.owner?undefined:'unavailable'})}>{q.owner?'Show all active records':'Unavailable owners'}</a></p>
      {field&&<p>{field.label} · {reportValueLabel(field,q.value||null)}</p>}
      <form method="get"><input type="hidden" name="view" value="custom-objects"/><input type="hidden" name="objectId" value={q.objectId}/>
        {q.owner&&<input type="hidden" name="owner" value={q.owner}/>}
        {q.sum&&<input type="hidden" name="sum" value={q.sum}/>}
        {field&&<><input type="hidden" name="by" value={field.id}/><input type="hidden" name="value" value={q.value}/></>}
        {workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
        <label>Search records<input placeholder="Name or property value" name="search" defaultValue={q.search} maxLength={120}/></label>
        {!field&&!q.owner&&<label><input type="checkbox" name="archived" value="1" defaultChecked={!!q.archived}/> Show archived records</label>}<button>Apply</button></form>
      {result.items.length?<ul>{result.items.map(r=><li key={r.id}><a href={objectPath({workspaceId,objectId:q.objectId,record:r.id,back:q.owner})}>{r.name}</a></li>)}</ul>:<p>No matching records.</p>}</>;
  }else if(result.view==='related'){
    body=result.items.length?<ul>{result.items.map(row=><li key={row.id}><a href={objectPath({workspaceId,objectId:row.objectId,record:row.recordId})}>{row.name}</a> · {row.typeName}</li>)}</ul>:<p>No linked custom records.</p>;
  }else{
    body=<>{!shared&&!q.summary&&<a href={objectPath({mode:'settings'})}>Create object</a>}
      {!q.summary&&<p><a href={objectPath({workspaceId,owner:q.owner?undefined:'unavailable'})}>{q.owner?'Show all custom objects':'Unavailable owners'}</a></p>}
      {result.items.length?<ul>{result.items.map(t=><li key={t.id}><a href={objectPath({workspaceId,objectId:t.id,summary:q.summary,owner:q.owner})}>{t.name}</a></li>)}</ul>:<p>{q.owner?'No custom objects have records with unavailable owners.':'No custom objects yet.'}</p>}</>;
  }
  return <main className="portable-contacts"><PortableCrmHeader email={user.email} page={q.summary?'reports':'custom-objects'} workspaceId={workspaceId}/>
    <section>{(mode||result.view!=='types')&&<p><a href={root}>{q.summary?'Custom object reports':'Custom objects'}</a>
      {(mode&&result.view==='list'||result.view==='record')&&<> / <a href={list}>{result.type.definition.name}</a></>}</p>}
      <h1>{mode==='settings'?(q.objectId?'Object settings':'Create custom object'):mode==='import'?'Import '+heading:mode==='create'?'Add record':heading}</h1>
      {body}{!mode&&result.view!=='record'&&result.view!=='summary'&&result.next&&<a href={objectPath({...params,after:result.next})}>Next page</a>}
    </section></main>;
}
