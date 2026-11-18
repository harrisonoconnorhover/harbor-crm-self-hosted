import {and,eq,gt,isNull,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {guestProofWindow,guestRequestDay,guestRequestLimit,guestRequestRetention,type GuestBookingClaim} from '../../lib/calendar/guest-booking';
import {workspaceEmailBlocked} from './email-suppression-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {portableGuestBookingRequests as requests,portablePublishedAvailability as pages} from './portable-meeting-schema';
import {portableCalendarSlotHeld} from './portable-meeting-store';

type Db=PostgresJsDatabase;
type Page={workspaceId:string;ownerId:string;id:string};
const scope=(page:Page,id:string)=>and(eq(requests.workspaceId,page.workspaceId),eq(requests.pageId,page.id),eq(requests.id,id));
async function activePage(db:Db,page:Page){
  const [saved]=await db.select({id:pages.id}).from(pages).where(and(eq(pages.workspaceId,page.workspaceId),eq(pages.id,page.id),eq(pages.allowGuestProof,true)));
  return !!saved;
}

export function claimPortableGuestRequest(db:Db,page:Page,claim:GuestBookingClaim){
  return db.transaction(async tx=>{
    if(await lockRecordWorkspace(tx,page.ownerId,false,undefined,undefined,true)!==page.workspaceId||
      !await activePage(tx,page)||await workspaceEmailBlocked(tx,page.workspaceId,claim.email)||
      await portableCalendarSlotHeld(tx,page.ownerId,Date.parse(claim.start),Date.parse(claim.end)))return false;
    const recent=claim.createdAt-guestRequestDay;
    const [result]=await tx.execute<{total:number;repeat:boolean}>(sql`
      SELECT count(*)::int AS total, coalesce(bool_or(email=${claim.email} AND created_at>${claim.createdAt-guestProofWindow}),false) AS repeat
      FROM portable_guest_booking_requests WHERE workspace_id=${page.workspaceId} AND created_at>${recent}
    `);
    if(result.total>=guestRequestLimit||result.repeat)return false;
    const saved=await tx.insert(requests).values(claim).onConflictDoNothing().returning({id:requests.id});
    return saved.length===1;
  });
}

export async function prunePortableGuestRequests(db:Db,now:number){
  await db.execute(sql`DELETE FROM portable_guest_booking_requests WHERE (workspace_id,id) IN (
    SELECT workspace_id,id FROM portable_guest_booking_requests WHERE created_at<=${now-guestRequestRetention}
    ORDER BY created_at LIMIT 25)`);
}

export function verifyPortableGuestRequest(db:Db,page:Page,id:string,codeHash:string,now:number,issueReceipt:()=>Promise<string>){
  return db.transaction(async tx=>{
    if(await lockRecordWorkspace(tx,page.ownerId,false,undefined,undefined,true)!==page.workspaceId||!await activePage(tx,page))return null;
    const eligible=and(scope(page,id),eq(requests.codeHash,codeHash),gt(requests.expiresAt,now));
    const [prior]=await tx.select({verifiedAt:requests.verifiedAt,receipt:requests.statusReceipt}).from(requests).where(eligible);
    if(!prior||prior.verifiedAt!==null)return prior?.receipt??null;
    const [saved]=await tx.update(requests).set({verifiedAt:now,statusReceipt:await issueReceipt()})
      .where(and(eligible,isNull(requests.verifiedAt))).returning({receipt:requests.statusReceipt});
    return saved?.receipt??null;
  });
}

export async function portableGuestDeliveryAllowed(db:Db,page:Page,claim:GuestBookingClaim){
  return Date.now()<claim.expiresAt&&await activePage(db,page)&&!await workspaceEmailBlocked(db,page.workspaceId,claim.email);
}

export async function recordPortableGuestDelivery(db:Db,page:Page,id:string,delivery:string,providerId?:string){
  await db.update(requests).set({delivery,providerId}).where(scope(page,id));
}
