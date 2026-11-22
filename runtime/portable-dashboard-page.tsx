import {notFound} from 'next/navigation';
import {listPortableCustomProperties} from '../db/postgres/custom-property-store';
import {listPortableDashboards,readPortableDashboard} from '../db/postgres/portable-dashboard-store';
import {readPortableReports} from '../db/postgres/portable-report-store';
import {readDealPipelines} from '../db/postgres/deal-pipeline-store';
import {readDealsWithoutFollowUp} from '../db/postgres/deal-follow-up-store';
import {portableWorkspaceAssignees} from '../db/postgres/workspace-assignee-store';
import {portableDashboardRead,type PortableDashboardFilters} from '../lib/portable-dashboards';
import {portableReportPipelineOptions} from '../lib/portable-reports';
import {portableDb} from './portable-db';
import {PortableDashboards} from './portable-dashboards-ui';

export async function PortableDashboardPage({user,dashboardId,after,search,workspaceId,filters}:{filters:PortableDashboardFilters;user:{userId:string;email:string};dashboardId?:string;after?:string;search?:string;workspaceId?:string}){
  const query=portableDashboardRead.safeParse({view:'dashboards',after,search,workspaceId});
  const selection=dashboardId===undefined?undefined:portableDashboardRead.safeParse({view:'dashboard',id:dashboardId,workspaceId});
  if(!query.success||query.data.view!=='dashboards'||selection&&!selection.success)notFound();
  const db=portableDb();
  const showFollowUp=!dashboardId&&!after&&!search;
  const [page,detail,reports,followUp]=await Promise.all([
    listPortableDashboards(db,user.userId,query.data),
    selection?.success&&selection.data.view==='dashboard'?readPortableDashboard(db,user.userId,selection.data.id,workspaceId,filters):undefined,
    workspaceId?{items:[],next:null}:readPortableReports(db,user.userId,{view:'library',limit:25}),
    showFollowUp?readDealsWithoutFollowUp(db,user.userId,workspaceId):undefined,
  ]);
  if(!page||dashboardId!==undefined&&!detail||!reports||!('items' in reports))notFound();
  const definitions=detail?.cards.flatMap(card=>'definition' in card?[card.definition]:[])??[];
  const propertyIds=new Set(definitions.flatMap(definition=>definition.customFilter?.propertyId??[]));
  const kinds=(['contacts','companies','deals'] as const).filter(kind=>
    definitions.some(definition=>definition.kind===kind&&definition.customFilter));
  const [pipelines,assignees,...properties]=await Promise.all([
    definitions.some(definition=>definition.kind==='deals')
      ?readDealPipelines(db,user.userId,workspaceId):[],
    definitions.some(definition=>typeof definition.taskAssigneeId==='string')
      ?portableWorkspaceAssignees(db,user.userId,workspaceId):[],
    ...kinds.map(kind=>listPortableCustomProperties(db,user.userId,kind,workspaceId)),
  ]);
  const customProperties=properties.flat().filter(({id})=>propertyIds.has(id)).map(({id,label})=>({id,label}));
  return <PortableDashboards key={detail?detail.item.id+':'+detail.item.revision:'new'} email={user.email}
    filters={filters} workspaceId={workspaceId} page={page} after={after} search={search} detail={detail??undefined} reports={reports} followUp={followUp}
    pipelines={portableReportPipelineOptions(pipelines)}
    assignees={assignees.filter(assignee=>definitions.some(d=>d.taskAssigneeId===assignee.id))} customProperties={customProperties}/>;
}
