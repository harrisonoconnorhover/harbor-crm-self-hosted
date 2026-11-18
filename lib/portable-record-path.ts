import type {Kind} from './crm';

export function portableRecordPath(kind:Kind,id:string,workspaceId?:string){
  const params=new URLSearchParams();
  if(kind==='tickets')params.set('id',id);
  else if(kind==='contacts')params.set('contact',id);
  else{params.set('kind',kind);params.set('record',id);}
  if(workspaceId)params.set('workspaceId',workspaceId);
  return (kind==='tickets'?'/tickets?':'/?')+params;
}
