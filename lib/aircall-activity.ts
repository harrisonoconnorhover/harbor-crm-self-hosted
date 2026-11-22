// Aircall activities written by the embedded phone use an application-defined UUID.
// Keep this format stable: historic activities identify their call with it.
const prefix='a17ca110-0000-8000-8';

export function aircallActivityId(callId:number){
  if(!Number.isSafeInteger(callId)||callId<1)throw new RangeError('Invalid Aircall call ID');
  const digits=callId.toString(16).padStart(15,'0');
  return prefix+digits.slice(0,3)+'-'+digits.slice(3);
}

export function aircallRecordingPage(activityId:string){
  if(!activityId.startsWith(prefix))return;
  const digits=activityId.slice(prefix.length);
  if(!/^[0-9a-f]{3}-[0-9a-f]{12}$/.test(digits))return;
  const callId=Number.parseInt(digits.replace('-',''),16);
  if(Number.isSafeInteger(callId)&&callId>0)return 'https://assets.aircall.io/recording/'+callId;
}

export type AircallAsset='recording'|'transcript';
