export async function readGoogleResponseJSON(response:Response,maxBytes=256000):Promise<unknown>{
 const reader=response.body?.getReader();
 if(!reader)throw Error('Empty provider response.');
 let size=0;
 const decoder=new TextDecoder();
 let text='';
 try{
  for(;;){
   const {value,done}=await reader.read();
   if(done)break;
   size+=value.length;
   if(size>maxBytes)throw Error('Provider response too large.');
   text+=decoder.decode(value,{stream:true});
  }
  return JSON.parse(text+decoder.decode());
 }catch(error){
  await reader.cancel().catch(()=>{});
  throw error;
 }finally{reader.releaseLock();}
}

type RefreshFailure={code:'reauth'|'unavailable'|'rejected';message:string};
export async function googleRefreshFailure(request:RequestInit,response:Response,service:'Gmail'|'Google Calendar'):Promise<RefreshFailure|null>{
 if(!(request.body instanceof URLSearchParams)||request.body.get('grant_type')!=='refresh_token')return null;
 // Only a verified invalid grant on the token endpoint warrants reconnecting.
 // Provider descriptions can contain private data and never leave this reader.
 if(response.status===400||response.status===401){
  const payload=await readGoogleResponseJSON(response,4096).catch(()=>null);
  const reason=payload&&typeof payload==='object'&&'error' in payload?payload.error:undefined;
  if(response.status===400&&reason==='invalid_grant')return {code:'reauth',message:`Reconnect ${service} to continue.`};
 }else{
  await response.body?.cancel().catch(()=>{});
 }
 if(response.status===429)return {code:'unavailable',message:`${service} refresh is rate limited. Try again later.`};
 if(response.status>=500)return {code:'unavailable',message:`${service} is temporarily unavailable. Try again later.`};
 return {code:'rejected',message:`Google could not refresh ${service}. If it persists, ask your administrator to check the Google connection settings.`};
}
