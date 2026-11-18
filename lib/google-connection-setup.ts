export type GoogleConnectionValues={clientId?:string;clientSecret?:string;redirectUri?:string;key?:string};
export type GoogleConnectionSetup={configured:boolean;checks:{credentials:'ready'|'missing';callback:'ready'|'missing'|'invalid'|'wrong_origin';encryption:'ready'|'missing'|'invalid'};expectedCallback?:string};

// Check saved settings only. Never return credentials or call a provider.
// Origin is supplied by the authenticated connection-status route when present.
export function googleConnectionSetup(values:GoogleConnectionValues,callbackPath:string,origin?:string):GoogleConnectionSetup{
 const credentials=values.clientId&&values.clientSecret?'ready':'missing';
 let callback:GoogleConnectionSetup['checks']['callback']=values.redirectUri?'invalid':'missing';
 if(values.redirectUri)try{
  const u=new URL(values.redirectUri),local=u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname);
  if((u.protocol==='https:'||local)&&u.pathname===callbackPath&&!u.search&&!u.hash&&!u.username&&!u.password)callback=origin&&u.origin!==origin?'wrong_origin':'ready';
 }catch{/* Invalid saved callback. */}
 let encryption:GoogleConnectionSetup['checks']['encryption']=values.key?'invalid':'missing';
 if(values.key)try{if(atob(values.key.replaceAll('-','+').replaceAll('_','/')).length===32)encryption='ready';}catch{/* Invalid saved key. */}
 return {configured:credentials==='ready'&&callback==='ready'&&encryption==='ready',checks:{credentials,callback,encryption},...(origin?{expectedCallback:origin+callbackPath}:{})};
}
