import {evaluatePortableReport,readPortableReports,writePortableReport} from '../db/postgres/portable-report-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableReportRead,portableReportWrite} from '../lib/portable-reports';
import {portableApiIdentity} from './portable-api-identity';
import {portableReportCsvResponse} from './portable-report-csv';
import {portableDb} from './portable-db';
import {dashboardRead,dashboardWrite} from './portable-dashboard-routes';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const errors={
  missing:{message:'Report not found.',status:404},
  stale:{message:'This report changed. Reload it before saving.',status:409},
};

async function reportRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method==='GET'||request.method==='HEAD'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid report query.'},400);
      const queryObject=Object.fromEntries(params);
      if(queryObject.view==='dashboards'||queryObject.view==='dashboard'||queryObject.view==='dashboardRecords')return await dashboardRead(db,user.userId,queryObject);
      const query=portableReportRead.safeParse(queryObject);
      if(!query.success)return json({error:'Invalid report query.'},400);
      const result=await readPortableReports(db,user.userId,query.data);
      if(!result)return json({error:errors.missing.message},errors.missing.status);
      return json('items' in result?result:{item:result});
    }
    if(params.size)return json({error:'Open your own workspace to manage reports.'},403);
    let raw:unknown;
    try{const text=await readBoundedRequestText(request,8_192);if(text!==null)raw=JSON.parse(text);}catch{}
    if(raw&&typeof raw==='object'&&'action' in raw&&(raw.action==='dashboard'||raw.action==='deleteDashboard')){
      return await dashboardWrite(db,user.userId,raw);
    }
    const input=portableReportWrite.safeParse(raw);
    if(!input.success)return json({error:'Check the report name, source, measure, grouping and filter.'},400);
    if(input.data.action==='preview')return json({result:await evaluatePortableReport(db,user.userId,input.data.definition)});
    if(input.data.action==='export')return await portableReportCsvResponse(db,user.userId,input.data);
    const result=await writePortableReport(db,user.userId,input.data);
    if('error' in result){
      const error=errors[result.error];
      return json({error:error.message},error.status);
    }
    return json(result,'id' in input.data?200:201);
  }catch{
    console.error('Portable report request failed.');
    return json({error:'Could not finish this report request.'},500);
  }
}

export {reportRoute as GET,reportRoute as POST};
