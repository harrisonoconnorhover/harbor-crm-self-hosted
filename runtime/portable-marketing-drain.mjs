// A pass owns any claimed recipient through its final receipt, including after a stop.
const normalStates=new Set(['accepted','skipped','delivered','suppressed','bounced','complained']);
const stopStates=new Set(['stopped','idle','disabled','waiting_for_sync','uncertain','failed','retry','throttled']);

/**
 * @param {{limit:number,rate:number,concurrency:number,durationMs:number,
 *   pass:(onDispatchStarted:()=>void)=>Promise<string>,signal?:AbortSignal,paceDispatch?:boolean}} options
 * @returns {Promise<{counts:Record<string,number>,started:number,elapsedMs:number,stoppedBy:string}>}
 */
export async function runMarketingDrain({limit,rate,concurrency,durationMs,pass,signal,paceDispatch=false}){
  if(![limit,concurrency,durationMs].every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isFinite(rate)||rate<=0){
    throw new RangeError('Use positive execution limits and dispatch rate.');
  }

  const began=performance.now(),deadline=began+durationMs,interval=1000/rate;
  const inFlight=new Set(),counts={};
  let started=0,nextStart=began,awaitingDispatch=false,stoppedBy,firstError;
  let wake;
  const onAbort=()=>{stoppedBy??='signal';wake?.();};

  function start(){
    started++;
    nextStart=performance.now()+interval;
    awaitingDispatch=paceDispatch;
    let released=false;
    function onDispatchStarted(){
      if(!paceDispatch||released)return;
      released=true;
      awaitingDispatch=false;
      nextStart=performance.now()+interval;
      wake?.();
    }
    async function execute(){
      try{
        const state=await pass(onDispatchStarted);
        if(!normalStates.has(state)&&!stopStates.has(state))throw Error('Unexpected marketing pass outcome.');
        counts[state]=(counts[state]??0)+1;
        if(stopStates.has(state))stoppedBy??=state;
      }catch(error){
        if(!firstError)firstError={error};
        stoppedBy??='error';
      }finally{
        // A skipped or rejected claim can finish without reaching the transport.
        onDispatchStarted();
      }
    }
    const task=execute().finally(()=>{inFlight.delete(task);wake?.();});
    inFlight.add(task);
  }

  function waitForChange(delay){
    return new Promise(resolve=>{
      const timer=setTimeout(resume,Math.min(2_147_483_647,Math.ceil(delay)));
      function resume(){
        clearTimeout(timer);
        wake=undefined;
        resolve();
      }
      wake=resume;
    });
  }

  signal?.addEventListener('abort',onAbort);
  try{
    if(signal?.aborted)onAbort();
    while(!stoppedBy&&started<limit){
      const now=performance.now();
      if(now>=deadline){stoppedBy='duration';break;}
      if(inFlight.size>=concurrency||awaitingDispatch)await waitForChange(deadline-now);
      else if(now<nextStart)await waitForChange(Math.min(deadline,nextStart)-now);
      else start();
    }
    await Promise.all(inFlight);
    if(firstError)throw firstError.error;
    return {counts,started,elapsedMs:Math.ceil(performance.now()-began),stoppedBy:stoppedBy??'limit'};
  }finally{
    signal?.removeEventListener('abort',onAbort);
  }
}
