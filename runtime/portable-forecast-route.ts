import {saveForecastGoal,setForecastCalendar} from '../db/postgres/forecast-goal-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {forecastCalendarWrite,forecastGoalWrite} from '../lib/portable-forecast';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {requestSessionHash} from './portable-identity';

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'private, no-store'}});
export async function POST(request:Request){
  const user=await portableApiIdentity(request);
  if(user instanceof Response)return user;
  const url=new URL(request.url);
  if(user.guest||url.search||request.headers.get('origin')!==url.origin)return json({error:'Only the workspace owner can set goals.'},403);
  const sessionHash=await requestSessionHash(request.headers);
  if(!sessionHash)return json({error:'Sign in again.'},403);
  try{
    const body=await readBoundedRequestText(request,2048);
    const raw=body===null?null:JSON.parse(body);
    const calendar=forecastCalendarWrite.safeParse(raw);
    if(calendar.success)return json(await setForecastCalendar(portableDb(),{...user,sessionHash},calendar.data.start,calendar.data.expectedStart));
    const input=forecastGoalWrite.safeParse(raw);
    if(!input.success)return json({error:'Check the period, pipeline, owner and goal amount.'},400);
    return json(await saveForecastGoal(portableDb(),{...user,sessionHash},input.data));
  }catch(error){
    if(error instanceof SyntaxError)return json({error:'Invalid goal.'},400);
    if(error instanceof ApiError)return json({error:error.message},error.status);
    return json({error:'Could not confirm the goal. Reload to check the saved amount.'},503);
  }
}
