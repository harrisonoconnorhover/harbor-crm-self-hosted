import {z} from 'zod';
import {ApiError} from '../api-error';
import {readBoundedRequestText} from '../bounded-request-text';
import {availabilityPageInput,type AvailabilityPageInput,type AvailabilityState} from './published-availability';

export async function ownerAvailabilityRoute<T>(request:Request,enabled:boolean,
  authorize:()=>Promise<T|Response>,load:(owner:T)=>Promise<AvailabilityState>,
  save:(owner:T,input:AvailabilityPageInput)=>Promise<AvailabilityState>){
  const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
  try{
    const owner=await authorize();
    if(owner instanceof Response)return owner;
    if(!enabled){
      if(request.method==='GET')return json({enabled:false,revision:null,page:null});
      throw new ApiError(404,'Availability sharing is off on this host.');
    }
    if(request.method==='GET')return json({enabled,...await load(owner)});
    const text=await readBoundedRequestText(request,4096);
    if(text===null)throw new ApiError(413,'The availability page is too large.');
    return json({enabled,...await save(owner,availabilityPageInput.parse(JSON.parse(text)))});
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:'Check the title and selected times.'},400);
    console.error('Availability page request failed.');
    return json({error:'Could not confirm the availability page. Refresh and check the saved page.'},503);
  }
}
