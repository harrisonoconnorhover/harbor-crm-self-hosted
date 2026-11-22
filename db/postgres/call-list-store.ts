import {sql} from 'drizzle-orm';
import {matchesSearchWords} from './search-index';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {deals} from './deal-schema';
import {ownedRecordScope} from './record-ownership-scope';
import type {AircallAsset} from '../../lib/aircall-activity';
import {portableContactActivities,reportedAircallAssets} from './portable-contact-activity-schema';
import {portableRecordActivities} from './portable-record-activity-schema';
import {privateWorkspaces} from './workspace-schema';

export type CallHome='contacts'|'companies'|'deals';
export type CallCursor={at:number;id:string;home:CallHome};
type CallRow={id:string;at:string;home:CallHome;record_id:string;name:string;summary:string;assets:AircallAsset[]|null};

export async function readCallList(db:PostgresJsDatabase,actorId:string,workspaceId?:string,after?:CallCursor,search?:string){
  function source(home:CallHome){
    const record={contacts,companies,deals}[home];
    const activity=home==='contacts'?portableContactActivities:portableRecordActivities;
    const recordId={contacts:portableContactActivities.contactId,companies:portableRecordActivities.companyId,deals:portableRecordActivities.dealId}[home];
    const access=workspaceId?ownedRecordScope(db,actorId,workspaceId,record,'view',home==='contacts'?'contactOutreach':'recordActivities'):
      sql`${privateWorkspaces.ownerId}=${actorId}`;
    return sql`SELECT ${activity.id} AS id, ${activity.occurredAt} AS at, ${home}::text AS home,
      ${record.id} AS record_id, ${record.data}->>'name' AS name, ${activity.summary} AS summary,
      ${home==='contacts'?reportedAircallAssets(activity.workspaceId,activity.id):sql`NULL::jsonb`} AS assets
      FROM ${activity} JOIN ${record} ON ${record.workspaceId}=${activity.workspaceId} AND ${record.id}=${recordId}
      JOIN ${privateWorkspaces} ON ${privateWorkspaces.id}=${record.workspaceId}
      WHERE ${access} AND ${record.archivedAt} IS NULL AND ${activity.kind}='Call'
      ${search?sql`AND ${matchesSearchWords(activity.summary,search)}`:sql``}`;
  }
  const rows=await db.execute<CallRow>(sql`SELECT * FROM (
    ${source('contacts')} UNION ALL ${source('companies')} UNION ALL ${source('deals')}
    ) calls ${after?sql`WHERE (at,id,home)<(${after.at}::bigint,${after.id}::uuid,${after.home}::text)`:sql``}
    ORDER BY at DESC,id DESC,home DESC LIMIT 26`);
  const items=rows.slice(0,25),last=items.at(-1);
  return {items,next:rows.length>25&&last?{at:Number(last.at),id:last.id,home:last.home}:undefined};
}
