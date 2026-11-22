import {aircallRecordingPage,type AircallAsset} from '../lib/aircall-activity';

export function PortableAircallLink({activityId,assets}:{activityId:string;assets?:AircallAsset[]|null}){
  const href=aircallRecordingPage(activityId);
  return href?<>
    {assets?.length?<span>Aircall reported {assets.join(' and ')} ready. </span>:null}
    <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      Check recording and transcript in Aircall
    </a>
  </>:null;
}
