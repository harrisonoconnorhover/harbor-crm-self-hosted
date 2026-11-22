import {z} from 'zod';

const name=z.object({
  workspaceId:z.string().guid().transform(id=>id.toLowerCase()),
  name:z.string().min(1).max(80).refine(value=>value===value.trim()&&!Array.from(value).some(char=>char.charCodeAt(0)<32)),
}).strict();
const destination=name.extend({
  url:z.string().max(4096).refine(value=>{
    const parsed=URL.parse(value);
    return parsed?.protocol==='https:'&&value===value.trim()&&!parsed.username&&!parsed.password&&!value.includes('#');
  }),
  secret:z.string().min(32).max(4096),
});
export type WebhookDestination=z.output<typeof destination>;

function readDestinations<T extends {workspaceId:string;name:string}>(item:z.ZodType<T>):T[]{
  const raw=process.env.HARBOR_WEBHOOK_DESTINATIONS;
  if(!raw)return [];
  try{
    const items=z.array(item).max(256).parse(JSON.parse(raw));
    if(new Set(items.map(d=>JSON.stringify([d.workspaceId,d.name]))).size===items.length)return items;
  }catch{/* Configuration errors must never echo a URL or signing secret. */}
  throw Error('Invalid HARBOR_WEBHOOK_DESTINATIONS. Check each workspace and unique name. Workers also require the HTTPS URL and signing secret.');
}

export function webhookDestinations():WebhookDestination[]{
  return readDestinations(destination);
}

export function configuredWebhookDestinations(workspaceId:string):string[]{
  return readDestinations(z.union([name,destination])).filter(d=>d.workspaceId===workspaceId).map(d=>d.name);
}
