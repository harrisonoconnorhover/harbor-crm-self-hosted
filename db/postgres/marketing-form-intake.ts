import {and,eq} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {marketingFormDeliveries,marketingFormRoutes} from './marketing-form-schema';

type Tx=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

// The caller already holds the workspace lock used by form configuration, quota and idempotent submission admission.
export async function queueMarketingFormDeliveries(tx:Tx,workspaceId:string,formId:string,inquiryId:string,at:number){
  const [route]=await tx.select().from(marketingFormRoutes)
    .where(and(eq(marketingFormRoutes.workspaceId,workspaceId),eq(marketingFormRoutes.formId,formId)));
  if(!route)return;
  const targets:{kind:'email'|'salesforce';destination:string}[]=route.recipients.map(destination=>({kind:'email',destination}));
  if(route.salesforceTarget)targets.push({kind:'salesforce',destination:route.salesforceTarget});
  if(targets.length)await tx.insert(marketingFormDeliveries).values(targets.map(target=>({
    workspaceId,id:crypto.randomUUID(),formId,inquiryId,routeId:route.routeId,...target,state:'pending' as const,
    createdAt:at,updatedAt:at,nextAt:at,
  })));
}
