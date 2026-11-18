import {listPortableDashboards,readDashboardRecords,readPortableDashboard,writePortableDashboard} from '../db/postgres/portable-dashboard-store';
import {portableDashboardRead,portableDashboardWrite} from '../lib/portable-dashboards';
import type {portableDb} from './portable-db';

type Db=ReturnType<typeof portableDb>;
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const errors={
  missing:{message:'Dashboard not found.',status:404},
  stale:{message:'This dashboard changed. Reload it before saving.',status:409},
  report_missing:{message:'One or more saved reports are unavailable in this workspace.',status:404},
};

export async function dashboardRead(db:Db,actorId:string,query:Record<string,string>){
  const input=portableDashboardRead.safeParse(query);
  if(!input.success)return json({error:'Invalid dashboard query.'},400);
  const queryData=input.data;
  const result=queryData.view==='dashboards'?await listPortableDashboards(db,actorId,queryData):
    queryData.view==='dashboardRecords'?await readDashboardRecords(db,actorId,queryData):
    await readPortableDashboard(db,actorId,queryData.id,queryData.workspaceId);
  return result?json(result):json({error:errors.missing.message},errors.missing.status);
}

export async function dashboardWrite(db:Db,actorId:string,raw:unknown){
  const input=portableDashboardWrite.safeParse(raw);
  if(!input.success)return json({error:input.error.issues[0]?.message??'Check the dashboard name and reports.'},400);
  const result=await writePortableDashboard(db,actorId,input.data);
  if('error' in result){
    const error=errors[result.error];
    return json({error:error.message},error.status);
  }
  return json(result,'id' in input.data?200:201);
}
