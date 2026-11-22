import {PortableCrmHeader} from './portable-crm-header';
import {listSharedReports} from '../db/postgres/portable-dashboard-store';
import {recordSearchLimit} from '../lib/portable-records';
import {notFound} from 'next/navigation';
import {evaluatePortableReport,readPortableReports} from '../db/postgres/portable-report-store';
import {readDealPipelines} from '../db/postgres/deal-pipeline-store';
import {listPortableCustomProperties} from '../db/postgres/custom-property-store';
import {portableWorkspaceAssignees} from '../db/postgres/workspace-assignee-store';
import {portableReportPipelineOptions,portableReportRead} from '../lib/portable-reports';
import {readDirectoryTeams} from '../db/postgres/workspace-team-store';
import {readOwnedWorkspaceId} from '../db/postgres/private-workspace-store';
import {portableDb} from './portable-db';
import {PortableReports} from './portable-reports-ui';

export async function PortableReportPage({user,reportId,after,search}:{user:{userId:string;email:string};reportId?:string;after?:string;search?:string}){
  const pageQuery=portableReportRead.safeParse({after,search});
  const selection=reportId===undefined?undefined:portableReportRead.safeParse({id:reportId});
  if(!pageQuery.success||selection&&!selection.success)notFound();
  const db=portableDb();
  const [page,item,pipelines,assignees,teams,...custom]=await Promise.all([
    readPortableReports(db,user.userId,pageQuery.data),
    selection?.success?readPortableReports(db,user.userId,selection.data):undefined,
    readDealPipelines(db,user.userId),
    portableWorkspaceAssignees(db,user.userId),
    readOwnedWorkspaceId(db,user.userId).then(id=>id?readDirectoryTeams(db,id):[]),
    ...(['contacts','companies','deals'] as const).map(kind=>listPortableCustomProperties(db,user.userId,kind)),
  ]);
  if(!page||!('items' in page)||reportId!==undefined&&(!item||!('definition' in item)))notFound();
  const saved=item&&'definition' in item?item:undefined;
  const result=saved?await evaluatePortableReport(db,user.userId,saved.definition):undefined;
  return <PortableReports key={saved?saved.id+':'+saved.revision:'new'} email={user.email} page={page} after={after} search={search}
    item={saved} result={result} pipelines={portableReportPipelineOptions(pipelines)} assignees={assignees} teams={teams} customProperties={custom.flat()}/>;
}

export async function SharedReportPage({user,workspaceId,after,search}:{user:{userId:string;email:string};workspaceId:string;after?:string;search?:string}){
  const query=portableReportRead.safeParse({after,search});
  if(!query.success||!('limit' in query.data))notFound();
  const page=await listSharedReports(portableDb(),user.userId,workspaceId,query.data);
  if(!page)notFound();
  const library='/?'+new URLSearchParams({view:'reports',workspaceId,...(search?{search}:{})});
  return <main className="portable-contacts">
    <PortableCrmHeader email={user.email} page="reports" workspaceId={workspaceId}/>
    <section aria-labelledby="shared-reports-title">
      <div className="portable-contacts-heading"><h1 id="shared-reports-title">Reports</h1>
        <a href={'/?view=custom-objects&summary=1&workspaceId='+workspaceId}>Custom object reports</a></div>
      <form method="get" action="/" role="search" className="portable-dashboard-search">
        <input type="hidden" name="view" value="reports"/><input type="hidden" name="workspaceId" value={workspaceId}/>
        <label>Search shared reports<input key={search??''} name="search" type="search" maxLength={recordSearchLimit} defaultValue={search}/></label>
        <button type="submit">Search</button>{search&&<a href={'/?view=reports&workspaceId='+workspaceId}>Clear search</a>}
      </form>
      {page.items.length?<div className="portable-contacts-table"><table><caption>Reports on shared dashboards</caption>
        <thead><tr><th scope="col">Report</th><th scope="col">Dashboard</th></tr></thead>
        <tbody>{page.items.map(report=><tr key={report.id}><th scope="row">
          <a href={'/?view=dashboards&dashboardId='+report.dashboardId+'&workspaceId='+workspaceId+'#report-'+report.id}>{report.name}</a>
        </th><td>{report.dashboardName}</td></tr>)}</tbody>
      </table></div>:<p>{search?'No matching shared reports.':'No reports on shared dashboards on this page.'}</p>}
      {(after||page.next)&&<nav aria-label="Report pages">
        {after&&<a href={library}>First reports</a>}{page.next&&<a href={library+'&after='+page.next}>Next reports</a>}
      </nav>}
    </section>
  </main>;
}
