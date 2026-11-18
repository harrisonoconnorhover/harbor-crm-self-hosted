import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import {createServer,type ServerResponse} from 'node:http';

export const googleGrantCallbackUrl='http://127.0.0.1:8775/google-grant/callback';
const callback=new URL(googleGrantCallbackUrl);
const authorizationWindow=5*60_000;

export class GoogleGrantLoopbackError extends Error {}

function respond(response:ServerResponse,status:number,message:string,location?:string){
  response.writeHead(status,{
    'content-type':'text/plain; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer',
    'connection':'close',...(location?{location}:{}),
  });
  response.end(message);
}

function completeResponse(response:ServerResponse,status:number,message:string,settle:()=>void){
  if(response.destroyed){settle();return;}
  // Let the browser receive the result, even if it disconnects during exchange.
  response.once('finish',settle);
  response.once('close',settle);
  respond(response,status,message);
}

export async function authorizePortableGoogleGrant({authorize,exchange}:{
  authorize:(state:string,challenge:string)=>string;
  exchange:(code:string,verifier:string)=>Promise<void>;
}):Promise<void>{
  const state=randomBytes(32).toString('base64url');
  const verifier=randomBytes(32).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const authorization=authorize(state,challenge);
  const expectedState=Buffer.from(state);
  const result=Promise.withResolvers<void>();
  let used=false;
  let deadline:ReturnType<typeof setTimeout>|undefined;

  const server=createServer((request,response)=>{
    if(request.method!=='GET'||request.headersDistinct.host?.length!==1||request.headers.host!==callback.host){
      respond(response,400,'This request cannot be used for Google authorization.');
      return;
    }
    if(used){
      respond(response,409,'This authorization attempt is already complete or in progress.');
      return;
    }
    if(request.url==='/'){
      respond(response,302,'Continue in Google to review the requested access.',authorization);
      return;
    }
    if(request.url?.split('?',1)[0]!==callback.pathname){
      respond(response,404,'This page is unavailable.');
      return;
    }
    const query=new URL(request.url,callback).searchParams;
    const receivedState=Buffer.from(query.get('state')??'');
    const code=query.get('code');
    const error=query.get('error');
    if(query.size!==new Set(query.keys()).size||receivedState.length!==expectedState.length||
      !timingSafeEqual(receivedState,expectedState)||(code===null?!error:!code||error!==null)){
      respond(response,400,'This Google authorization response is invalid.');
      return;
    }
    used=true;
    clearTimeout(deadline);
    if(!code){
      completeResponse(response,400,'Google authorization was not completed. Check your terminal.',
        ()=>result.reject(new GoogleGrantLoopbackError('Google authorization was not completed.')));
      return;
    }
    void Promise.resolve().then(()=>exchange(code,verifier)).then(
      ()=>completeResponse(response,200,'Authorization saved. Return to your terminal.',result.resolve),
      error=>completeResponse(response,400,'Authorization could not be saved. Check your terminal.',()=>result.reject(error)),
    );
  });
  try{await once(server.listen(Number(callback.port),callback.hostname),'listening');}
  catch{throw new GoogleGrantLoopbackError('Could not start the Google authorization listener on port 8775. Check whether the port is in use.');}

  try{
    server.on('error',()=>result.reject(new GoogleGrantLoopbackError('The local Google authorization listener encountered an error.')));
    deadline=setTimeout(()=>{
      used=true;
      result.reject(new GoogleGrantLoopbackError('Google authorization expired. Start a new attempt.'));
    },authorizationWindow);
    console.log('Open '+callback.origin+'/ in your browser.');
    await result.promise;
  }finally{
    clearTimeout(deadline);
    await new Promise<void>(resolve=>{
      server.close(()=>resolve());
      server.closeAllConnections();
    });
  }
}
