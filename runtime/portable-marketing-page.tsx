import {notFound} from 'next/navigation';
import {marketingWorkspaceForOwner} from '../db/postgres/marketing-workspace-store';
import {marketingAudienceStatus} from '../db/postgres/marketing-audience-store';
import {ApiError} from '../lib/api-error';
import {portableDb} from './portable-db';
import {PortableCrmHeader} from './portable-crm-header';
import {PortableMarketingUI} from './portable-marketing-ui';

export async function PortableMarketingPage({user,campaigns=false}:{user:{email:string;userId:string};campaigns?:boolean}){
  const db=portableDb();
  let workspaceId;
  try{workspaceId=await marketingWorkspaceForOwner(db,user.userId);}
  catch(error){if(error instanceof ApiError)notFound();throw error;}
  return <main className="portable-contacts">
    <PortableCrmHeader email={user.email} page={campaigns?'campaigns':'marketing'}/>
    <PortableMarketingUI campaignsHome={campaigns} initialStatus={await marketingAudienceStatus(db,workspaceId)}/>
  </main>;
}
