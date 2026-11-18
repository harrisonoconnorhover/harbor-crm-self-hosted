import {notFound} from 'next/navigation';
import {evaluatePortableReport,readPortableReports} from '../db/postgres/portable-report-store';
import {readDealPipelines} from '../db/postgres/deal-pipeline-store';
import {listPortableCustomProperties} from '../db/postgres/custom-property-store';
import {portableWorkspaceAssignees} from '../db/postgres/workspace-assignee-store';
import {portableReportPipelineOptions,portableReportRead} from '../lib/portable-reports';
import {portableDb} from './portable-db';
import {PortableReports} from './portable-reports-ui';

export async function PortableReportPage({user,reportId,after,search}:{user:{userId:string;email:string};reportId?:string;after?:string;search?:string}){
  const pageQuery=portableReportRead.safeParse({after,search});
  const selection=reportId===undefined?undefined:portableReportRead.safeParse({id:reportId});
  if(!pageQuery.success||selection&&!selection.success)notFound();
  const db=portableDb();
  const [page,item,pipelines,assignees,...custom]=await Promise.all([
    readPortableReports(db,user.userId,pageQuery.data),
    selection?.success?readPortableReports(db,user.userId,selection.data):undefined,
    readDealPipelines(db,user.userId),
    portableWorkspaceAssignees(db,user.userId),
    ...(['contacts','companies','deals'] as const).map(kind=>listPortableCustomProperties(db,user.userId,kind)),
  ]);
  if(!page||!('items' in page)||reportId!==undefined&&(!item||!('definition' in item)))notFound();
  const saved=item&&'definition' in item?item:undefined;
  const result=saved?await evaluatePortableReport(db,user.userId,saved.definition):undefined;
  return <PortableReports key={saved?saved.id+':'+saved.revision:'new'} email={user.email} page={page} after={after} search={search}
    item={saved} result={result} pipelines={portableReportPipelineOptions(pipelines)} assignees={assignees} customProperties={custom.flat()}/>;
}
