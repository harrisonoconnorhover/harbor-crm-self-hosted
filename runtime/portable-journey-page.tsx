import {portablePageHasBody} from './portable-page-body';
import {notFound} from 'next/navigation';
import {z} from 'zod';
import {attributionQuery,trafficQuery} from '../lib/portable-web-attribution';
import {readAttribution,readTraffic} from '../db/postgres/web-attribution-store';
import {ApiError} from '../lib/api-error';
import {PortableCrmHeader} from './portable-crm-header';
import {portableDb} from './portable-db';
import {WebAttribution,WebsiteTraffic} from './portable-journey-ui';

const pageQuery=attributionQuery.safeExtend({
  view:z.literal('web-attribution'),creditGroup:z.enum(['Source','Medium','Campaign']).optional(),tab:z.enum(['report','sites']).optional(),
}).refine(v=>v.tab!=='sites'||(!v.contactId&&!v.inquiryId&&v.beforeId===undefined));

function handleUnavailable(error:unknown):never{
  if(error instanceof ApiError&&error.status===404)notFound();
  throw error;
}

export async function WebAttributionPage({user,input}:{
  user:{email:string;userId:string};input:Record<string,string|undefined>;
}){
  if(input.tab==='traffic'){
    const {view,...filters}=input;
    const query=trafficQuery.safeParse(filters);
    if(view!=='web-attribution'||!query.success)notFound();
    const result=await readTraffic(portableDb(),user.userId,query.data).catch(handleUnavailable);
    return <main className="portable-contacts"><PortableCrmHeader email={user.email} page="web-attribution"/>
      <WebsiteTraffic result={result} query={query.data}/></main>;
  }
  const parsed=pageQuery.safeParse(input);
  if(!parsed.success)notFound();
  const {siteId,contactId,inquiryId,tab,period,creditGroup,beforeAt,beforeId,through}=parsed.data;
  const cursor=beforeAt!==undefined&&beforeId!==undefined&&through!==undefined?{beforeAt,beforeId,through}:undefined;
  const report=await readAttribution(portableDb(),user,parsed.data,await portablePageHasBody()).catch(handleUnavailable);
  if(siteId&&!report.sites.some(site=>site.id===siteId)||inquiryId&&!report.selected)notFound();
  return <main className="portable-contacts"><PortableCrmHeader email={user.email} page="web-attribution"/>
    <WebAttribution key={JSON.stringify(parsed.data)} result={report} contactId={contactId} siteId={siteId} period={period} creditGroup={creditGroup} cursor={cursor}
      tab={tab??(contactId||report.sites.length?'report':'sites')} harborOrigin={new URL(process.env.HARBOR_LOGIN_ORIGIN!).origin}/>
  </main>;
}
