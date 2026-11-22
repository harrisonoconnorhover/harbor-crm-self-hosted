import type {Kind} from './crm';

export function portableRecordPath(kind:Kind,id:string,workspaceId?:string,returnPath?:string){
  const params=new URLSearchParams();
  if(kind==='tickets')params.set('id',id);
  else if(kind==='contacts')params.set('contact',id);
  else{params.set('kind',kind);params.set('record',id);}
  if(workspaceId)params.set('workspaceId',workspaceId);
  if(kind==='contacts'||kind==='companies'||kind==='deals'){
    const back=recordReturnPath(returnPath,workspaceId);
    if(back)params.set('back',back);
  }
  return (kind==='tickets'?'/tickets?':'/?')+params;
}

// Only carry CRM navigation for the workspace being viewed. Keep a linked record
// and its originating list so following associations cannot grow the URL forever.
const navigationKeys=new Set(['kind','record','contact','workspaceId','view','pipelineId','stage','owner','closeMonth','search','after','savedView','companyId','primaryContactId','back','dashboardId','reportId','createdFrom','createdThrough','dashboardPipeline']);
export function recordReturnPath(path:string|undefined,workspaceId?:string,depth=1):string|undefined{
  if(typeof path!=='string'||!path||path.length>4096||path!=='/'&&!path.startsWith('/?')||path.includes('#'))return;
  const params=new URLSearchParams(path.slice(2));
  if((params.get('workspaceId')??undefined)!==workspaceId)return;
  for(const key of params.keys())if(!navigationKeys.has(key)||params.getAll(key).length!==1)return;
  if(!['contacts','companies','deals'].includes(params.get('kind')??'contacts'))return;
  if(!['list','board','summary','reports','dashboards','calls'].includes(params.get('view')??'list'))return;
  const back=params.get('back');
  params.delete('back');
  if(back&&depth>0){
    const parent=recordReturnPath(back,workspaceId,depth-1);
    if(parent)params.set('back',parent);
  }
  return params.size?'/?'+params:'/';
}

export function recordReturnLabel(path:string){
  const params=new URLSearchParams(path.slice(2));
  const kind=params.get('kind')??'contacts';
  if(params.has('record')||params.has('contact'))return {contacts:'contact',companies:'company',deals:'deal'}[kind];
  if(params.get('view')==='calls')return 'Calls';
  if(params.get('view')==='dashboards')return 'dashboard';
  if(params.get('view')==='reports')return 'report';
  if(params.get('view')==='board')return 'deal board';
  if(params.get('view')==='summary')return 'pipeline summary';
  return {contacts:'Contacts',companies:'Companies',deals:'Deals'}[kind];
}
