import {readPortableSegments,writePortableSegment} from '../db/postgres/portable-segment-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableSegmentRead,portableSegmentWrite} from '../lib/portable-segments';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const errors={
  missing:{message:'Segment not found.',status:404},
  in_use:{message:'This segment is referenced by a workflow.',status:409},
  stale:{message:'This segment changed. Reload it before saving.',status:409},
  mode:{message:'A saved segment cannot change its type.',status:409},
  not_static:{message:'Active segment membership is controlled by filters.',status:400},
  invalid_contacts:{message:'Choose active Contacts from this workspace only.',status:400},
  request_conflict:{message:'That request ID was used for a different membership change.',status:409},
};

async function segmentRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method==='GET'||request.method==='HEAD'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid segment query.'},400);
      const query=portableSegmentRead.safeParse(Object.fromEntries(params));
      if(!query.success)return json({error:'Invalid segment query.'},400);
      const result=await readPortableSegments(db,user.userId,query.data);
      return result?json(result):json({error:errors.missing.message},errors.missing.status);
    }
    if(params.size)return json({error:'Open your own workspace to manage segments.'},403);
    let raw:unknown;
    try{const text=await readBoundedRequestText(request,8_192);if(text!==null)raw=JSON.parse(text);}catch{}
    const input=portableSegmentWrite.safeParse(raw);
    if(!input.success)return json({error:'Check the segment details and Contact selection.'},400);
    const result=await writePortableSegment(db,user.userId,input.data);
    if('error' in result){
      const error=errors[result.error];
      return json({error:error.message},error.status);
    }
    return json(result,input.data.action==='save'&&input.data.segment.revision===0?201:200);
  }catch{
    console.error('Portable segment request failed.');
    return json({error:'Could not finish this segment request.'},500);
  }
}

export {segmentRoute as GET,segmentRoute as POST};
