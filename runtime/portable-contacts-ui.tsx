'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Use document navigation for record lists in the portable renderer. */

import {useWorkspaceDefaults} from './portable-workspace-format';
import {workspaceDate,workspaceNumber} from '../lib/portable-account-defaults';
import {effectiveMemberToolPolicy,type ToolPolicies} from '../lib/portable-tool-permissions';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,ArrowLeft,Building2,ContactRound,Handshake,Link2,LockKeyhole,NotebookPen,Paperclip} from 'lucide-react';
import {lifecycles} from '../lib/crm';
import {portableSavedViewPath,type PortableSavedView} from '../lib/portable-saved-views';
import {portableDefaultRecordListColumns,portableRecordListColumns,portableRecordListValue} from '../lib/portable-record-list-columns';
import {PortableSavedViews} from './portable-saved-views-ui';
import {standardFields} from '../lib/standard-properties';
import {portableRecordLabels,recordSearchLimit,type CompanyFields,type CompanyRecord,type ContactFields,type ContactRecord,
  type DealFields,type DealRecord,type PortableRecordKind,type PortableRecordQuery} from '../lib/portable-records';
import {PortableDealBoard,type BlockedDealMove,type DealBoardData} from './portable-deal-board';
import {PortableDealSummary,type DealSummaryData} from './portable-deal-summary';
import type {DealPipeline} from '../lib/portable-deal-pipelines';
import {PortableDealFilterFields,PortableDealStage} from './portable-deal-pipeline-ui';
import {workspaceInvitationPath,type WorkspaceRole} from '../lib/portable-workspace-access';
import {PortableLoggedActivity} from './portable-contact-activity-ui';
import {taskLinkFields} from '../lib/portable-tasks';
import {PortablePropertyHistory} from './portable-property-history-ui';
import {PortableRecordProperties} from './portable-record-properties-ui';
import type {PropertyOrganization} from '../lib/property-groups';
import {PortableContactSequences} from './portable-contact-sequences-ui';
import {PortableContactText} from './portable-contact-text-ui';
import {PortableTaskHistory} from './portable-task-history-ui';
import {PortableMeetingInvite} from './portable-meeting-ui';
import {PortableContactJobs} from './portable-contact-jobs-ui';
import {PortableGmailInbox} from './portable-gmail-inbox-ui';
import {PortableOutlookRecords} from './portable-outlook-records-ui';
import {PortableContactFiles} from './portable-contact-files-ui';
import {PortableRecordPicker} from './portable-record-picker';
import {PortableRecordExport} from './portable-record-export-ui';
import {PortableQuoteCreate} from './portable-quotes-ui';
import {PortableInvoiceCreate} from './portable-invoices-ui';
import {DealLineItems} from '../app/products';
import {recordReturnLabel,recordReturnPath} from '../lib/portable-record-path';
import {PortableAssociations} from './portable-associations-ui';
import {PortableLinkedRecords,PortableLinkedCustomRecords} from './portable-linked-records';
import {PortableRecordImport} from './portable-contact-import-ui';
import {PortableWorkspaceSharing,type WorkspaceSharing} from './portable-workspace-ui';
import type {PortableCustomProperty} from '../lib/portable-custom-properties';
import {PortableCustomFields,readCustomPropertyEdits} from './portable-custom-properties-ui';
import {PortableRecycleAction,portableRecycleBinLink} from './portable-contact-recycle-ui';
import {portableDuplicatesLink} from '../lib/portable-duplicates';
import {PortableRecordBulkBar,type PortableBulkProperty,type PortableBulkSelection} from './portable-record-bulk-ui';
import {portableBulkExcludedFields,portableRecordBulkLimit} from '../lib/portable-record-bulk';
import {PortableCrmHeader} from './portable-crm-header';
import {PortableRecordListHeading} from './portable-record-list-heading';
import './portable-contacts.css';
import './portable-record-detail.css';

type Row=ContactRecord|CompanyRecord|DealRecord;
type RelatedRecord={kind:'companies'|'contacts';id:string;name:string};
type ListLink={after?:string;keepFilters?:boolean;view?:'list'|'board'|'summary';clearSearch?:boolean;clearCloseMonth?:boolean};
type Field=Exclude<keyof ContactFields|keyof CompanyFields|keyof DealFields,'custom'|'recordOwner'>;
type Props={stageEditable:boolean;currentPath:string;returnTo?:string;kind:PortableRecordKind;email:string;records:Row[];search?:string;owner?:PortableRecordQuery['owner'];sort?:PortableRecordQuery['sort'];next:string|null;paged:boolean;filesEnabled:boolean;
  propertyOrganization?:PropertyOrganization;hiddenStandardFields:string[];savedViews?:PortableSavedView[];activeViewId?:string;activeViewName?:string;activeViewColumns?:string[];lastContactedById?:Record<string,string|null>;customProperties:PortableCustomProperty[];assignees:{id:string;label:string;canReceive?:boolean}[];workspaceSharing?:WorkspaceSharing;
  initialRecord?:Row;startNewDeal?:boolean;related?:RelatedRecord;gmailSender?:string;gmailInboxEnabled?:boolean;aircallEnabled?:boolean;outlookMailEnabled?:boolean;outlookCalendarEnabled?:boolean;calendarAvailable:boolean;calendarInvites:boolean;pipelines:DealPipeline[];board?:DealBoardData;summary?:DealSummaryData;closeMonth?:string;pipelineId?:string;stage?:string;workspaceId?:string;grant?:{id:string;toolPolicies?:ToolPolicies;editScope:'all'|'team'|'owned';viewScope:'all'|'team'|'owned';role:WorkspaceRole;contactFiles:boolean;scheduledNotes:boolean;contactOutreach:boolean;recordActivities:boolean}};
const titles={contacts:'Contacts',companies:'Companies',deals:'Deals'} satisfies Record<PortableRecordKind,string>;
const searchByKind={contacts:'Name or email',companies:'Name or domain',deals:'Deal name'};
const fieldsByKind={
  contacts:[['name','Name'],['email','Email'],['phone','Phone'],['title','Job title']],
  companies:[['name','Name'],['domain','Domain'],['website','Website'],['industry','Industry'],['city','City']],
  deals:[['name','Name'],['amount','Amount'],['closeDate','Close date']],
} as const satisfies Record<PortableRecordKind,readonly (readonly [Field,string])[]>;
const inputTypes:Partial<Record<Field,string>>={email:'email',phone:'tel',website:'url',amount:'number',closeDate:'date'};
const fieldValues=(record:Row|null):Partial<Record<Field,string|number>>=>record?.data??{};
const contactRow=(record:Row|null)=>record&&'primaryCompanyId' in record?record:null;
const dealRow=(record:Row|null)=>record&&'primaryContactId' in record?record:null;
const link=(id:string|null|undefined,name:string|null|undefined,fallback:string)=>id?{id,name:name??fallback}:null;
const listColumnText=(value:unknown)=>typeof value==='boolean'?(value?'Yes':'No'):
  typeof value==='string'||typeof value==='number'?String(value)||'—':'—';

export function PortableRecords({currentPath,returnTo,kind,email,records,search,owner,sort,next,paged,filesEnabled,initialRecord,startNewDeal,related,gmailSender,gmailInboxEnabled,aircallEnabled,outlookMailEnabled=false,outlookCalendarEnabled=false,calendarAvailable,calendarInvites,pipelines,board,summary,closeMonth,pipelineId,stage,workspaceId,grant,savedViews,activeViewId,activeViewName,activeViewColumns,lastContactedById,customProperties,assignees,workspaceSharing,propertyOrganization,hiddenStandardFields,stageEditable}:Props){
  const display=useWorkspaceDefaults();
  function recordCell(field:string,value:unknown){
    if(display&&(typeof value==='number'||typeof value==='string'&&value!=='')){
      if(field==='amount'&&kind==='deals')return workspaceNumber(value,display,'money');
      if(['closeDate','createdAt','updatedAt','lastContacted'].includes(field))return workspaceDate(value,display,field!=='closeDate');
      if(typeof value==='number')return workspaceNumber(value,display);
    }
    return listColumnText(value);
  }
  const router=useRouter();
  const [editing,setEditing]=useState<Row|'new'|null>(initialRecord??(startNewDeal?'new':null));
  const [fullRecordEdit,setFullRecordEdit]=useState(false);
  const primaryEditor=useRef<HTMLFormElement>(null);
  const primaryFocus=useRef<string|null>(null);
  function openPrimaryEditor(field:string){
    primaryFocus.current=field;
    setFullRecordEdit(true);
  }
  useEffect(()=>{
    if(fullRecordEdit&&primaryFocus.current){
      const select=primaryEditor.current?.elements.namedItem(primaryFocus.current);
      if(select instanceof HTMLSelectElement)select.focus();
      primaryFocus.current=null;
    }
  },[fullRecordEdit]);
  const [saving,setSaving]=useState(false);
  const [archiving,setArchiving]=useState(false);
  const [selected,setSelected]=useState<PortableBulkSelection>(new Map());
  const [bulkBusy,setBulkBusy]=useState(false);
  const [outreachRefresh,setOutreachRefresh]=useState(0);
  const [status,setStatus]=useState('');
  const [error,setError]=useState('');
  const [staleRevision,setStaleRevision]=useState(false);
  const [missingStageFields,setMissingStageFields]=useState<string[]>([]);
  const [proposedStage,setProposedStage]=useState<string>();
  const recordHeading=useRef<HTMLHeadingElement>(null);
  const newRecordName=useRef<HTMLInputElement>(null);
  const current=editing==='new'?null:editing;
  const contact=contactRow(current),deal=dealRow(current),company=kind==='companies'?current:null;
  const focused=Boolean(current);
  const activeRecordId=current?.id;
  useEffect(()=>{
    if(activeRecordId&&!initialRecord)recordHeading.current?.focus();
  },[activeRecordId,initialRecord]);
  const RecordIcon=kind==='contacts'?ContactRound:kind==='companies'?Building2:Handshake;
  const contacts=kind==='contacts',deals=kind==='deals',title=titles[kind],label=portableRecordLabels[kind],singular=label.toLowerCase();
  const heading=related?title+' linked to '+related.name:title;
  const relatedCompany=deals&&related?.kind==='companies'?related:undefined;
  const relatedContact=deals&&related?.kind==='contacts'?related:undefined;
  const policy=grant&&effectiveMemberToolPolicy(grant,kind);
  const shared=!!workspaceId,limitedEdit=!!policy&&policy.edit!=='all',canCreate=!shared||policy?.create===true;
  const canEditRecord=(row?:Row|null)=>!shared||grant?.role==='editor'&&policy?.edit!=='none'&&(!limitedEdit||!row||
    row.data.recordOwner?.workspaceId===workspaceId&&assignees.some(member=>member.id===row.data.recordOwner?.userId));
  const readOnly=editing==='new'?!canCreate:!canEditRecord(current);
  const fieldVisible=(id:string)=>!hiddenStandardFields.includes(id);
  const fields=fieldsByKind[kind].filter(([id])=>fieldVisible(id)),values=fieldValues(current);
  useEffect(()=>{
    if(editing==='new'&&!deals)newRecordName.current?.focus();
  },[editing,deals]);
  const singleInvite=workspaceSharing?.incoming.length===1?workspaceSharing.incoming[0]:undefined;
  const singleShared=workspaceSharing?.shared.length===1?workspaceSharing.shared[0]:undefined;
  const moreWorkspaces=workspaceSharing&&(workspaceSharing.shared.length>1||workspaceSharing.incoming.length>1);
  const recycleScope=workspaceId&&grant?{workspaceId,grantId:grant.id}:undefined;
  const recordOwner=current?.data.recordOwner;
  const recipients=assignees.filter(member=>member.canReceive!==false);
  const inactiveOwner=recordOwner&&!recipients.some(choice=>choice.id===recordOwner.userId);
  const listCatalog=portableRecordListColumns(kind,customProperties,!shared||grant?.contactOutreach===true).filter(({id})=>fieldVisible(id));
  const listColumns=activeViewColumns?.[0]==='name'
    ?activeViewColumns.flatMap(id=>listCatalog.filter(column=>column.id===id))
    :portableDefaultRecordListColumns(kind).filter(({id})=>fieldVisible(id));
  const extensions=standardFields(kind).filter(({id})=>fieldVisible(id));
  const extensionValues:Record<string,unknown>=current?.data??{};
  // Stage moves use the list's pipeline; the server refuses a selection that spans pipelines.
  function bulkStage():PortableBulkProperty[]{
    if(!stageEditable)return [];
    const pipeline=pipelines.find(choice=>choice.id===(pipelineId??'default'));
    return pipeline?[{id:'stage',label:'Deal stage ('+pipeline.name+')',type:'select',options:pipeline.stages.map(choice=>choice.id),
      optionLabels:Object.fromEntries(pipeline.stages.map(choice=>[choice.id,choice.name]))}]:[];
  }
  // Moving across pipelines takes a pipeline and one of its stages together.
  const pipelineChoices=pipelines.flatMap(pipeline=>pipeline.stages.map(stage=>({id:pipeline.id+'/'+stage.id,label:pipeline.name+' › '+stage.name})));
  const bulkProperties:PortableBulkProperty[]=[
    ...fields.filter(([key])=>!(portableBulkExcludedFields[kind] as readonly string[]).includes(key))
      .map(([key,label])=>({id:key,label,type:({amount:'number',closeDate:'date'} as Record<string,string>)[key]??'text'})),
    ...(kind==='deals'?[...bulkStage(),...(stageEditable&&pipelines.length>1?[{id:'pipeline',label:'Pipeline and stage',type:'select',options:pipelineChoices.map(choice=>choice.id),
      optionLabels:Object.fromEntries(pipelineChoices.map(choice=>[choice.id,choice.label]))}]:[])]:[{id:'lifecycle',label:'Lifecycle stage',type:'select',options:lifecycles}]),
    ...extensions.map(field=>({id:field.id,label:field.label,type:field.type,options:field.options})),
    ...customProperties.map(custom=>({id:'custom:'+custom.id,label:custom.label,type:custom.type,options:custom.options})),
  ];
  const showActivities=!shared||(contacts?grant?.contactOutreach:grant?.recordActivities);
  const showNotes=contacts&&(!shared||grant?.scheduledNotes);
  const filePolicy=grant&&effectiveMemberToolPolicy(grant,'files');
  const showFiles=contacts&&filesEnabled&&(!shared||grant?.contactFiles&&filePolicy?.view!=='none');
  const savedViewPath=activeViewId?portableSavedViewPath(kind,activeViewId,undefined,workspaceId):undefined;
  function pageLink(selected:PortableRecordKind,{after,keepFilters,view='list',clearSearch,clearCloseMonth}:ListLink={}){
    const query=new URLSearchParams();
    if(selected!=='contacts')query.set('kind',selected);
    if(workspaceId)query.set('workspaceId',workspaceId);
    if(keepFilters&&related)query.set(related.kind==='companies'?'companyId':'primaryContactId',related.id);
    if(keepFilters&&pipelineId)query.set('pipelineId',pipelineId);
    if(keepFilters&&stage&&view==='list')query.set('stage',stage);
    if(keepFilters&&search&&view!=='summary'&&!clearSearch)query.set('search',search);
    if(keepFilters&&owner&&view!=='summary')query.set('owner',owner);
    if(keepFilters&&closeMonth&&!clearCloseMonth)query.set('closeMonth',closeMonth);
    if(view!=='list')query.set('view',view);
    if(after)query.set('after',after);
    return query.size?'/?'+query:'/';
  }

  function tasksPage(target?:{kind:PortableRecordKind;id:string;status?:'Completed';add?:true}){
    const query=new URLSearchParams({kind:'tasks'});
    if(workspaceId)query.set('workspaceId',workspaceId);
    if(target)query.set(taskLinkFields[target.kind],target.id);
    if(target?.status)query.set('status',target.status);
    if(target?.add)query.set('add','1');
    return '/?'+query;
  }

  function linkedPage(target:PortableRecordKind,parameter:string,id:string){
    const query=new URLSearchParams({[parameter]:id});
    if(target!=='contacts')query.set('kind',target);
    if(workspaceId)query.set('workspaceId',workspaceId);
    return '/?'+query;
  }

  function recordLink(target:PortableRecordKind,id:string){
    if(initialRecord&&target===kind&&id===initialRecord.id)return currentPath;
    const path=linkedPage(target,target==='contacts'?'contact':'record',id);
    if(target===kind&&currentPath===pageLink(kind))return path;
    const back=recordReturnPath(currentPath,workspaceId);
    return back?path+'&'+new URLSearchParams({back}):path;
  }

  function edit(record:typeof editing,move?:BlockedDealMove){
    setFullRecordEdit(Boolean(move));
    setEditing(record);
    setProposedStage(move?.stageId);
    setError(move?.message??'');
    setStaleRevision(false);
    setMissingStageFields(move?.missingFields.map(({field})=>field)??[]);
    setStatus('');
  }

  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(archiving)return;
    const {primaryCompanyId,companyId,primaryContactId,pipelineId:chosenPipeline,stageSelection,assigneeId,...data}=Object.fromEntries(new FormData(event.currentTarget));
    const custom=deals&&chosenPipeline!=='default';
    const customPatch=readCustomPropertyEdits(data,customProperties,current?.data.custom);
    const typedData:Record<string,unknown>={...data,custom:customPatch};
    if(deals&&data.amount!==undefined)typedData.amount=Number(data.amount);
    for(const field of extensions){
      const value=data[field.id];
      if(value===undefined||value===String(extensionValues[field.id]??'')){
        delete typedData[field.id];
      }else if(field.type==='number'){
        typedData[field.id]=value===''?null:Number(value);
      }else if(field.type==='checkbox'){
        typedData[field.id]=value===''?null:value==='true';
      }
    }
    setSaving(true);
    setError('');
    setStaleRevision(false);
    try{
      const scope=workspaceId&&grant?'?'+new URLSearchParams({workspaceId,grantId:grant.id}):'';
      const response=await fetch('/api/crm'+scope,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        action:'save',kind,data:deals?{...typedData,stage:custom?undefined:stageSelection}:typedData,
        ...(deals?{companyId:(companyId||null)===(deal?.companyId??null)?undefined:companyId||null,primaryContactId:(primaryContactId||null)===(deal?.primaryContactId??null)?undefined:primaryContactId||null,
          pipelineId:custom?chosenPipeline:null,stageId:custom?stageSelection:null}:{}),...(contacts?{primaryCompanyId:(primaryCompanyId||null)===(contact?.primaryCompanyId??null)?undefined:primaryCompanyId||null}:{}),
        ...(typeof assigneeId==='string'&&assigneeId!==(recordOwner?.userId??'')?{assigneeId:assigneeId||null}:{}),
        ...(current?{id:current.id,expectedRevision:current.revision}:{}),
      })});
      if(!response.ok){
        const result=await response.json() as {error?:string;code?:string;fields?:{field:string}[]};
        setError(result.error||'Could not save '+singular+'.');
        setStaleRevision(result.code==='stale_revision');
        setMissingStageFields(result.fields?.map(item=>item.field)??[]);
        return;
      }
      if(current){
        const {record}=await response.json() as {record?:Row};
        if(record?.id!==current.id)throw Error('Saved record was missing from the response.');
        edit(record);
      }else edit(null);
      setStatus(label+(current?' updated.':' added.'));
      if(startNewDeal)router.replace(pageLink('deals',{keepFilters:true}));
      else router.refresh();
    }catch{
      setError('Could not confirm the save. Refresh the list to check.');
    }finally{setSaving(false);}
  }

  const sharingTools=shared?(contacts&&!related&&!initialRecord&&<details>
    <summary>Your workspace access</summary>
    <p>{readOnly?'Open a contact to see its details. Ask the workspace owner for Editor access to make changes.':
      limitedEdit?'Open a contact to see its details. You can edit contacts within your assigned scope.':'Open a contact to edit it, or choose Add contact to create one in this workspace.'}</p>
    <p>The owner manages access to files, scheduled Notes, and logged activities.</p>
    <ul>
      <li>Contact files · {showFiles?(['Download',...(!readOnly&&filePolicy?.create!==false?['upload']:[]),...(!readOnly&&filePolicy?.edit!=='none'?['replace']:[])].join(', ')):'Unavailable'}</li>
      <li>Scheduled Notes · {showNotes?(readOnly?'Read':'Read and schedule on editable contacts'):'Unavailable'}</li>
      <li>Logged Contact activities · {showActivities?(readOnly?'Read':'Read and log on editable records'):'Unavailable'}</li>
      <li>Logged Company and Deal activities · {grant?.recordActivities?(readOnly?'Read':'Read and log on editable records'):'Unavailable'}</li>
    </ul>
  </details>):<PortableWorkspaceSharing initial={workspaceSharing}/>;
  const binAvailable=!grant||effectiveMemberToolPolicy(grant,'recycle-bin').view!=='none';
  const manageLinks=!readOnly&&(binAvailable||!deals)&&<p>{binAvailable&&<a href={portableRecycleBinLink(kind,workspaceId)}>Recycle Bin</a>}{!deals&&<>{binAvailable?' · ':''}<a href={portableDuplicatesLink(kind,workspaceId)}>Manage duplicates</a></>}</p>;
  const savedViewTools=savedViews&&<PortableSavedViews key={'saved-views:'+(activeViewId??kind)} kind={kind} views={savedViews} activeId={activeViewId} workspaceId={workspaceId} grantId={grant?.role==='editor'&&!limitedEdit?grant.id:undefined} outreach={!shared||grant?.contactOutreach===true}
    filters={{search,owner,stage,pipelineId,closeMonth,sort}} columnCatalog={listCatalog}/>;
  const fileTools=!shared&&!board&&!summary&&<>
    <PortableRecordExport kind={kind} listLink={activeViewId?portableSavedViewPath(kind,activeViewId):pageLink(kind,{keepFilters:true})}/>
    {!related&&<PortableRecordImport key={'record-import:'+kind} kind={kind} customProperties={customProperties}/>}
    {contacts&&!related&&!initialRecord&&<PortableRecordImport kind="paired" customProperties={[]}/>}
  </>;
  const propertySettings=!shared&&!related&&!board&&!summary&&!initialRecord&&<p><a href={'/?view=settings&section=properties&kind='+kind}>Manage properties</a></p>;
  const allInScope=related?linkedPage(kind,related.kind==='companies'?'companyId':'primaryContactId',related.id):pageLink(kind);

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page={kind} workspaceId={workspaceId}
      recycleHref={readOnly?undefined:portableRecycleBinLink(kind,workspaceId)}
      filesEnabled={filesEnabled} calendarAvailable={calendarAvailable}/>
    <section aria-labelledby="portable-contacts-title" className={focused?'portable-record-detail':!deals?'portable-record-list':!related?'portable-deals':undefined}>
      {current&&<header className="portable-record-heading">
        <nav aria-label="Record breadcrumb">
          {initialRecord?<a href={returnTo??pageLink(kind,{keepFilters:true})}><ArrowLeft size={16} aria-hidden="true"/>Back to {returnTo?recordReturnLabel(returnTo):title}</a>:
            <button type="button" onClick={()=>edit(null)} disabled={saving||archiving}><ArrowLeft size={16} aria-hidden="true"/>Back to {board?'board':title}</button>}
        </nav>
        <div className="portable-record-identity">
          <span className="portable-record-icon"><RecordIcon size={24} aria-hidden="true"/></span>
          <div><h1 id="portable-contacts-title" ref={recordHeading} tabIndex={-1}>{current.data.name}</h1>
            <p>{[label,contact?.data.title??deal?.stageName??values.industry,shared?(readOnly?'View only':'Shared workspace'):null].filter(Boolean).join(' · ')}</p>
          </div>
          {!fullRecordEdit&&<PortableRecordProperties key={kind+':'+current.id} kind={kind} record={current}
            customProperties={customProperties} hiddenStandardFields={hiddenStandardFields} organization={propertyOrganization} lastContacted={lastContactedById?.[current.id]}/>}
        </div>
        <nav className="portable-record-jumps" aria-label="On this record">
          <a href="#portable-record-properties">Properties</a>
          {showActivities?<a href="#portable-logged-activities"><Activity size={15} aria-hidden="true"/>Activity</a>:
            <a href="#portable-activity-access"><LockKeyhole size={15} aria-hidden="true"/>Activity access</a>}
          {contact&&!shared&&<a href="#portable-sales-sequences">Sequences</a>}
          {deal&&<a href="#portable-task-history">Task history</a>}
          {showNotes&&<a href="#portable-contact-jobs"><NotebookPen size={15} aria-hidden="true"/>Scheduled notes</a>}
          {showFiles&&<a href="#portable-contact-files"><Paperclip size={15} aria-hidden="true"/>Files</a>}
          <a href="#portable-record-links"><Link2 size={15} aria-hidden="true"/>Linked records</a>
        </nav>
      </header>}
      {!focused&&<>
      <p className="portable-workspace-context">
        <strong>{shared?(readOnly?'Shared workspace · View only':'Shared workspace · Editor'):'Your workspace'}</strong>
        {singleInvite&&<a href={workspaceInvitationPath(singleInvite.id)}>Review invitation from {singleInvite.ownerEmail}</a>}
        {singleShared&&<a href={'/?workspaceId='+singleShared.id}>Open workspace from {singleShared.ownerEmail}</a>}
        {moreWorkspaces&&<a href="/?view=workspaces">View workspaces and invitations</a>}
      </p>
      {deals?<><div className="portable-contacts-heading"><h1 id="portable-contacts-title">{heading}</h1>
        {canCreate&&!summary&&<button type="button" onClick={()=>edit('new')} disabled={saving||archiving}>{'Add '+singular}</button>}</div>
        {savedViewTools}{sharingTools}{manageLinks}</>:
        <><PortableRecordListHeading title={heading} singular={singular} onAdd={canCreate&&!related?()=>edit('new'):undefined}
          disabled={saving||archiving} transfers={fileTools} exportOnly={!!related} readOnly={readOnly} settings={(sharingTools||manageLinks)&&<>
            {propertySettings}{sharingTools}{manageLinks}
          </>}/>
          {savedViewTools&&<div className="portable-list-views">{savedViewTools}</div>}
        </>}
      {related&&<p><a href={recordLink(related.kind,related.id)}>Back to {related.name}</a></p>}
      {deals&&!shared&&!related&&!summary&&<a href="/?view=settings&section=pipelines">Deal pipeline settings</a>}
      {deals&&!related&&<nav aria-label="Deal view">
        <a href={savedViewPath??pageLink('deals',{keepFilters:true})}
          aria-current={!board&&!summary?'page':undefined}>List</a>
        <a href={savedViewPath?savedViewPath+'&view=board':pageLink('deals',{keepFilters:true,view:'board'})} aria-current={board?'page':undefined}>Board</a>
        <a href={pageLink('deals',{keepFilters:true,view:'summary'})} aria-current={summary?'page':undefined}>Summary</a>
      </nav>}
      {board&&activeViewName&&<p><strong>{activeViewName}</strong> · All pipeline stages</p>}
      {!summary&&<form action="/" method="get" className={!deals?'portable-list-filters':!related?'portable-deal-filters':undefined}
        aria-label={board?'Board pipeline':deals&&!related?'Deal filters':'Search '+title.toLowerCase()}>
        <input type="hidden" name="kind" value={kind}/>
        {board&&<input type="hidden" name="view" value="board"/>}
        {workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
        {related&&<input type="hidden" name={related.kind==='companies'?'companyId':'primaryContactId'} value={related.id}/>}
        {closeMonth&&<input type="hidden" name="closeMonth" value={closeMonth}/>}
        <fieldset>
          <label>Search {title.toLowerCase()}<input key={search??''} name="search" type="search"
            placeholder={searchByKind[kind]} maxLength={recordSearchLimit} defaultValue={search}/></label>
          <label>Filter by record owner<select key={owner??''} name="owner" defaultValue={owner??''}>
            <option value="">All owners</option>
            <option value="mine">Assigned to me</option>
            {(limitedEdit&&grant?.role==='editor'||owner==='editable')&&<option value="editable">Records I can edit</option>}
            <option value="unassigned">Unassigned</option>
            <option value="unavailable">Unavailable owners</option>
            {assignees.map(assignee=><option key={assignee.id} value={assignee.id}>{assignee.label}</option>)}
            {owner&&owner!=='mine'&&owner!=='unassigned'&&owner!=='unavailable'&&owner!=='editable'&&!assignees.some(assignee=>assignee.id===owner)&&
              <option value={owner}>Selected owner</option>}
          </select></label>
          {board?<label>Pipeline<select key={board.pipeline.id} name="pipelineId" defaultValue={board.pipeline.id}>
            {pipelines.map(option=><option key={option.id} value={option.id}>{option.name}</option>)}
          </select></label>:deals&&!related&&<PortableDealFilterFields key={JSON.stringify([pipelineId,stage])}
            pipelines={pipelines} pipelineId={pipelineId} stage={stage}/>}
          {related&&pipelineId&&<input type="hidden" name="pipelineId" value={pipelineId}/>}
          {related&&stage&&<input type="hidden" name="stage" value={stage}/>}
        </fieldset>
        <button type="submit">{board?'Show pipeline':deals&&!related?'Apply filters':'Search'}</button>
        {!deals&&(search||owner)?<a href={allInScope}>Clear filters</a>:search&&<> <a href={pageLink(kind,{keepFilters:true,clearSearch:true,view:board?'board':'list'})}>Clear search</a></>}
      </form>}
      {deals&&<>{fileTools}{propertySettings}</>}
      {deals&&!summary&&closeMonth&&<p>{closeMonth==='undated'?'No close date':'Close month '+closeMonth}{' '}
        <a href={pageLink('deals',{keepFilters:true,clearCloseMonth:true,view:board?'board':'list'})}>Clear close date filter</a></p>}
      </>}
      {status&&<p role="status">{status}</p>}
      <div className={focused?'portable-record-layout':undefined}>
      <div className={focused?'portable-record-profile':undefined} id={focused?'portable-record-properties':undefined}
        tabIndex={focused?-1:undefined}>
      {contact&&!readOnly&&!fullRecordEdit&&<PortableContactText key={contact.id} contact={contact} scope={recycleScope}
        disabled={archiving} reloadHref={recordLink('contacts',contact.id)} onEditAll={()=>setFullRecordEdit(true)}
        onSave={saved=>{
          setEditing(previous=>previous&&previous!=='new'&&previous.id===saved.id&&previous.revision<saved.revision?saved:previous);
          router.refresh();
        }}/>}
      {current&&(readOnly||!fullRecordEdit&&!contact)&&<section className="portable-record-properties" aria-label="Key information">
        <div className="portable-record-card-heading"><h2>Key information</h2>
          {!readOnly&&<button type="button" disabled={archiving} onClick={()=>setFullRecordEdit(true)}>Edit all properties</button>}
        </div>
        <dl className="portable-property-grid">
          {fields.filter(([key])=>key!=='name').map(([key,fieldLabel])=><div key={key}><dt>{fieldLabel}</dt>
            <dd>{display?recordCell(key,values[key]):typeof values[key]==='number'?values[key].toLocaleString():values[key]||'—'}</dd></div>)}
          <div><dt>Record owner</dt><dd>{recordOwner?.label??'Unassigned'}</dd></div>
          {deal?<><div><dt>Pipeline</dt><dd>{deal.pipelineName}</dd></div><div><dt>Deal stage</dt><dd>{deal.stageName}</dd></div></>:
            <div><dt>Lifecycle stage</dt><dd>{'lifecycle' in current.data?current.data.lifecycle:'—'}</dd></div>}
        </dl>
      </section>}
      {editing&&!readOnly&&(!current||fullRecordEdit)&&<form ref={primaryEditor} className="portable-record-editor"
        key={current?'editor:'+current.id+':'+current.revision:'editor:new'} onSubmit={save}>
        <h2>{(current?'Edit ':'Add ')+singular}</h2>
        <fieldset disabled={saving||archiving}>
          {fields.map(([key,label])=><label key={key}>{label}
            <input name={key} type={inputTypes[key]??'text'} defaultValue={values[key]} required={key==='name'}
              ref={editing==='new'&&!deals&&key==='name'?newRecordName:undefined}
              aria-invalid={missingStageFields.includes(key)||undefined}
              {...(key==='amount'?{min:0,max:1e12,step:'any'}:{})}/>
          </label>)}
          <label>Record owner<select name="assigneeId" defaultValue={recordOwner?.userId??''}>
            {(!limitedEdit||!current)&&<option value="">{limitedEdit?'Assign to me':'Unassigned'}</option>}
            {inactiveOwner&&<option value={recordOwner.userId}>{recordOwner.label} (unavailable)</option>}
            {recipients.map(({id,label})=><option key={id} value={id}>{label}</option>)}
          </select></label>
          {deals?<PortableDealStage key={proposedStage} stageEditable={stageEditable} existing={!!deal} pipelines={pipelines} pipelineId={deal?(deal.pipelineId??'default'):(pipelineId??'default')}
            stage={proposedStage??(deal?(deal.stageId??deal.data.stage):stage)}/>:<label>Lifecycle stage<select name="lifecycle" defaultValue={values.lifecycle??'Lead'}>
            {lifecycles.map(stage=><option key={stage}>{stage}</option>)}
          </select></label>}
          {contacts&&<PortableRecordPicker kind="companies" field="primaryCompanyId" editableOnly={limitedEdit} label="Primary company"
            value={link(contact?.primaryCompanyId,contact?.primaryCompanyName,'Current company')} workspaceId={workspaceId}/>}
          {deals&&<>
            <PortableRecordPicker kind="companies" field="companyId" editableOnly={limitedEdit} label="Company"
              value={editing==='new'?relatedCompany??null:link(deal?.companyId,deal?.companyName,'Current company')} workspaceId={workspaceId}/>
            <PortableRecordPicker kind="contacts" field="primaryContactId" editableOnly={limitedEdit} label="Primary contact"
              value={editing==='new'?relatedContact??null:link(deal?.primaryContactId,deal?.primaryContactName,'Current contact')} workspaceId={workspaceId}/>
          </>}
          <details open={extensions.some(field=>missingStageFields.includes(field.id))||undefined}>
            <summary>More properties</summary>
            {extensions.map(field=>{
              const value=String(extensionValues[field.id]??'');
              const invalid=missingStageFields.includes(field.id)||undefined;
              return <label key={field.id}>{field.label}
                {field.type==='select'?<select name={field.id} defaultValue={value} aria-invalid={invalid}>
                  <option value="">Not set</option>
                  {field.options?.map(option=><option key={option}>{option}</option>)}
                </select>:field.type==='checkbox'?<select name={field.id} defaultValue={value} aria-invalid={invalid}>
                  <option value="">Not set</option><option value="true">Yes</option><option value="false">No</option>
                </select>:field.multiline?<textarea name={field.id} defaultValue={value} maxLength={2000} aria-invalid={invalid}/>:
                  <input name={field.id} type={field.inputType??field.type} defaultValue={value} aria-invalid={invalid}
                    min={field.type==='number'?0:undefined} step={field.type==='number'?'any':undefined}/>}
              </label>;
            })}
          </details>
          <PortableCustomFields properties={customProperties} values={current?.data.custom}
            missingFields={missingStageFields}/>
        </fieldset>
        {error&&<p role="alert">{error}</p>}
        {staleRevision&&current&&<p><a href={recordLink(kind,current.id)}>Reload latest {singular}</a>{' '}
          to replace this draft with the latest saved values.</p>}
        <button type="submit" disabled={saving||archiving}>{saving?'Saving…':'Save '+singular}</button>{' '}
        <button type="button" disabled={saving||archiving} onClick={()=>{
          if(current){
            edit(current);
            return;
          }
          edit(null);
          if(startNewDeal)router.replace(pageLink('deals',{keepFilters:true}));
        }}>Cancel</button>
      </form>}
      {current&&!fullRecordEdit&&<section className="portable-record-extra-properties" aria-label="More record properties">
        <PortablePropertyHistory key={'property-history:'+kind+':'+current.id+':'+current.revision} kind={kind} id={current.id}
          workspaceId={workspaceId} customProperties={customProperties} hiddenStandardFields={hiddenStandardFields}/>
        {!shared&&<p><a href={'/?'+new URLSearchParams({view:'record-access',kind,record:current.id})}>View record access history</a></p>}
      </section>}
      {current&&!readOnly&&policy?.delete!==false&&<div className="portable-record-archive"><PortableRecycleAction key={current.id+':'+current.revision}
        kind={kind} scope={recycleScope} action="archive" id={current.id} revision={current.revision} name={current.data.name}
        disabled={saving} onBusy={setArchiving} onDone={()=>{
          edit(null);
          setStatus(label+' archived.');
          if(initialRecord)router.replace(pageLink(kind));
          else router.refresh();
        }}/></div>}
      </div>
      {current&&<aside id="portable-record-links" className="portable-record-relationships" aria-label="Linked records" tabIndex={-1}>
        <section className="portable-record-properties">
          <div className="portable-record-card-heading"><h2>Linked records</h2></div>
          <nav aria-label="Record associations">
            {contact&&<div className="portable-linked-record-group">
              <h3>Primary company</h3>{contact.primaryCompanyId?<a href={recordLink('companies',contact.primaryCompanyId)}>{contact.primaryCompanyName??'Primary company'}</a>:<p>No visible primary company.</p>}
              {!readOnly&&!fullRecordEdit&&<button type="button" disabled={archiving} onClick={()=>openPrimaryEditor('primaryCompanyId')}>Edit primary company</button>}
            </div>}
            {kind==='companies'&&<PortableLinkedRecords key={'contacts:'+current.id} kind="contacts" field="companyId"
              id={current.id} workspaceId={workspaceId} href={linkedPage('contacts','companyId',current.id)}
              recordHref={id=>recordLink('contacts',id)}/>}
            {(company||contact)&&<PortableLinkedRecords key={'deals:'+current.id} kind="deals"
              field={company?'companyId':'primaryContactId'} id={current.id} workspaceId={workspaceId}
              href={linkedPage('deals',company?'companyId':'primaryContactId',current.id)}
              recordHref={id=>recordLink('deals',id)}
              addHref={readOnly||grant&&!effectiveMemberToolPolicy(grant,'deals').create?undefined:linkedPage('deals',company?'companyId':'primaryContactId',current.id)+'&add=1'}/>}
            {deal&&<div className="portable-linked-record-group">
              <h3>Company</h3>{deal.companyId?<a href={recordLink('companies',deal.companyId)}>{deal.companyName??'Company'}</a>:<p>No linked company.</p>}
              {!readOnly&&!fullRecordEdit&&<button type="button" disabled={archiving} onClick={()=>openPrimaryEditor('companyId')}>Edit company</button>}
            </div>}
            {deal&&<div className="portable-linked-record-group">
              <h3>Primary contact</h3>{deal.primaryContactId?<a href={recordLink('contacts',deal.primaryContactId)}>{deal.primaryContactName??'Primary contact'}</a>:<p>No linked contact.</p>}
              {!readOnly&&!fullRecordEdit&&<button type="button" disabled={archiving} onClick={()=>openPrimaryEditor('primaryContactId')}>Edit primary contact</button>}
            </div>}
            <div className="portable-linked-record-group portable-linked-record-actions">
              <a href={tasksPage({kind,id:current.id})}>Linked tasks</a>
              {!readOnly&&(!grant||effectiveMemberToolPolicy(grant,'tasks').create)&&<a className="portable-record-action" href={tasksPage({kind,id:current.id,add:true})}>Add task</a>}
              {!contacts&&<a href={tasksPage({kind,id:current.id,status:'Completed'})}>Completed tasks</a>}
              {kind!=='deals'&&(!shared||grant)&&<a href={'/tickets?'+new URLSearchParams({
                [contacts?'contactId':'companyId']:current.id,...(workspaceId?{workspaceId}:{}),
              })}>Linked tickets</a>}
              {contact&&!shared&&<a href={'/?'+new URLSearchParams({view:'web-attribution',contactId:contact.id})}>View conversion paths</a>}
              {company&&!shared&&<a href={'/?'+new URLSearchParams({view:'workflows',runCompanyId:company.id})+'#recent-runs'}>View Company workflow runs</a>}
              {deal&&!shared&&<a href={'/?'+new URLSearchParams({view:'workflows',runDealId:deal.id})+'#recent-runs'}>Workflow runs</a>}
            </div>
            <PortableLinkedCustomRecords key={kind+current.id+':'+(grant?.id??'own')} kind={kind} id={current.id} workspaceId={workspaceId}/>
          </nav>
        </section>
        <PortableAssociations recordHref={recordLink} key={kind+current.id+':'+(grant?.id??'own')} kind={kind} id={current.id}
          workspaceId={workspaceId} grantId={grant?.id} readOnly={readOnly} limitedEdit={limitedEdit}/>
      </aside>}
      {current&&<div className="portable-record-activity">
      {!showActivities&&<section id="portable-activity-access" className="portable-record-panel portable-activity-access" aria-label="Activity access" tabIndex={-1}>
        <h2>Activity history isn’t shared with you</h2>
        <p>To see calls, meetings and notes logged on {contacts?'contacts':'companies and deals'}, ask the workspace owner
          to turn on <strong>{contacts?'Contact outreach':'Company and deal activities'}</strong> for you in the Team directory.</p>
      </section>}
      {current&&(kind==='contacts'||kind==='deals')&&<PortableTaskHistory key={'task-history:'+kind+current.id+workspaceId} kind={kind} recordId={current.id} workspaceId={workspaceId}/>}
      {contact&&!shared&&<PortableContactSequences key={contact.id} contact={contact}/>}
      {showActivities&&contact&&<PortableLoggedActivity key={'outreach:'+contact.id} contactId={contact.id}
        dialPhone={aircallEnabled&&fieldVisible('phone')?contact.data.phone:undefined}
        workspaceId={workspaceId} grantId={grant?.id} readOnly={readOnly} refreshKey={outreachRefresh} onSaved={lastContactedById||sort?()=>router.refresh():undefined}/>}
      {showActivities&&current&&kind!=='contacts'&&<PortableLoggedActivity key={'activity:'+kind+':'+current.id+':'+(grant?.id??'own')}
        kind={kind} recordId={current.id} workspaceId={workspaceId} grantId={grant?.id} readOnly={readOnly}/>}
      {gmailInboxEnabled&&!shared&&contact?.data.email&&<PortableGmailInbox
        key={contact.id+':'+contact.data.email} recordId={contact.id} onLogged={()=>{
          setOutreachRefresh(value=>value+1);
          if(lastContactedById||sort)router.refresh();
        }}/>}
      {!shared&&contact?.data.email&&(outlookMailEnabled||outlookCalendarEnabled)&&<PortableOutlookRecords
        key={'outlook:'+contact.id+':'+contact.data.email+':'+outlookMailEnabled+':'+outlookCalendarEnabled}
        recordId={contact.id} contactEmail={contact.data.email} mail={outlookMailEnabled} calendar={outlookCalendarEnabled}
        onLogged={()=>{setOutreachRefresh(value=>value+1);if(lastContactedById||sort)router.refresh();}}/>}
      {calendarInvites&&!shared&&contact?.data.email&&<PortableMeetingInvite key={'meeting:'+contact.id}
        contactId={contact.id} recipient={contact.data.email}/>}
      {showNotes&&current&&<PortableContactJobs key={'scheduled-notes:'+current.id+':'+(grant?.id??'owner')} recordId={current.id} workspaceId={workspaceId}
        grantId={grant?.id} readOnly={readOnly} gmail={gmailSender&&contact?.data.email?{sender:gmailSender,recipient:contact.data.email}:undefined}/>}
      {showFiles&&current&&<PortableContactFiles key={'files:'+current.id} recordId={current.id} workspaceId={workspaceId}
        grantId={grant?.id} readOnly={readOnly} canCreate={filePolicy?.create!==false} canReplace={filePolicy?.edit!=='none'}/>}
      {deal&&!shared&&<DealLineItems key={'line-items:'+deal.id} dealId={deal.id} updatedAt={deal.updatedAt}
        onSaved={async()=>router.refresh()} revenueReportsAvailable={false}/>}
      {deal&&!shared&&<><PortableQuoteCreate key={deal.id} dealId={deal.id}/><PortableInvoiceCreate key={deal.id+"-invoice"} source="deal" sourceId={deal.id}/></>}
      </div>}
      </div>
      {!focused&&(summary?<PortableDealSummary key={summary.pipeline.id+':'+(closeMonth??'all')} summary={summary}
        pipelines={pipelines} closeMonth={closeMonth} showCloseDate={fieldVisible('closeDate')} workspaceId={workspaceId}/>:board?<PortableDealBoard recordHref={id=>recordLink('deals',id)} key={board.pipeline.id} board={board} filters={{search,owner,closeMonth}} workspaceId={workspaceId}
        grantId={grant?.id} canEdit={card=>stageEditable&&canEditRecord(card)} onEdit={edit}/>:<>
      {!readOnly&&<PortableRecordBulkBar canMerge={!grant||effectiveMemberToolPolicy(grant,'duplicates').edit!=='none'} canDelete={policy?.delete!==false} limitedEdit={limitedEdit} kind={kind} selected={selected} assignees={recipients} properties={bulkProperties} scope={recycleScope}
        disabled={bulkBusy||saving||archiving} onBusy={setBulkBusy} onClear={()=>setSelected(new Map())}
        onDone={(message,keep=[])=>{
          setSelected(previous=>new Map([...previous].filter(([id])=>keep.includes(id))));
          setStatus(message);
          router.refresh();
        }}/>}
      {!deals&&records.length>0&&<p className="portable-list-count">{records.length} {records.length===1?singular:kind} on this page</p>}
      {records.length?<div className="portable-contacts-table" role={deals?undefined:'region'}
        aria-label={deals?undefined:title+' table'} tabIndex={deals?undefined:0}><table>
        <thead><tr>{!readOnly&&<th scope="col">Select</th>}{listColumns.map(({id,label})=><th key={id} aria-sort={id==='lastContacted'&&sort?(sort==='outreach-newest'?'descending':'ascending'):undefined}>{label}</th>)}</tr></thead>
        <tbody>{records.map(record=>{
          const cellValues:Record<string,unknown>={...record.data,...record,lastContacted:lastContactedById?.[record.id]};
          const primaryCompany=contactRow(record);
          return <tr key={record.id} data-selected={!deals&&selected.has(record.id)||undefined}>{!readOnly&&<td><input type="checkbox" aria-label={'Select '+record.data.name}
            checked={selected.has(record.id)} disabled={bulkBusy||!canEditRecord(record)||(!selected.has(record.id)&&selected.size>=portableRecordBulkLimit)}
            onChange={event=>{
              const checked=event.currentTarget.checked;
              setSelected(previous=>{
                const next=new Map(previous);
                if(checked)next.set(record.id,{revision:record.revision,name:record.data.name});
                else next.delete(record.id);
                return next;
              });
            }}/></td>}{listColumns.map(({id})=>id==='name'
            ?<th key={id} scope="row"><a className="portable-record-name" href={recordLink(kind,record.id)}>{record.data.name}</a></th>
            :<td key={id}>{id==='primaryCompanyName'&&primaryCompany?.primaryCompanyId&&primaryCompany.primaryCompanyName
              ?<a className="portable-list-relation" href={recordLink('companies',primaryCompany.primaryCompanyId)}>{primaryCompany.primaryCompanyName}</a>
              :recordCell(id,portableRecordListValue(record,cellValues,id))}</td>)}</tr>;
        })}</tbody>
      </table></div>:deals?<p>{search||owner?'No matching '+kind+'.':'No '+kind+' on this page.'}</p>:
        <div className="portable-list-empty">
          <span className="portable-list-empty-mark"><RecordIcon size={22} aria-hidden="true"/></span>
          <h2>{search||owner?'No matching '+kind:paged?'No '+kind+' on this page':related?'No linked '+kind:'No '+kind+' yet'}</h2>
          <p>{search||owner?'Try a different search or clear the filters.':paged?'Return to the first page to continue browsing.':
            related?'Records linked to '+related.name+' will appear here.':readOnly?'Records shared by this workspace will appear here.':
            'Choose Add '+singular+(!shared?' to create the first record, or use Import / export to bring in a CSV.':' to create the first record.')}</p>
        </div>}
      <nav aria-label={title+' pages'}>{paged&&<a href={activeViewId?portableSavedViewPath(kind,activeViewId,undefined,workspaceId):pageLink(kind,{keepFilters:true})}>First page</a>}{next&&<a href={activeViewId?portableSavedViewPath(kind,activeViewId,next,workspaceId):pageLink(kind,{after:next,keepFilters:true})}>Next page</a>}</nav>
      </>)}
    </section>
  </main>;
}
