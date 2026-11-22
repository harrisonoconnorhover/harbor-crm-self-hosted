import {eq,gt,and,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {marketingMailCooldown as cooldown} from './marketing-campaign-schema';

const clock=sql`floor(extract(epoch from clock_timestamp())*1000)::bigint`;

export async function resendCooldownUntil(db:PostgresJsDatabase){
  const [active]=await db.select({until:cooldown.until}).from(cooldown)
    .where(and(eq(cooldown.provider,'resend'),gt(cooldown.until,clock)));
  return active?.until??null;
}

export async function resendCoolingDown(db:PostgresJsDatabase){
  return await resendCooldownUntil(db)!==null;
}

export function resendRetryDelay(error:unknown){
  if(!(error instanceof Error)||error.name!=='MarketingMailError'||!('retryAfterMs' in error))return null;
  const delay=error.retryAfterMs;
  return typeof delay==='number'&&Number.isSafeInteger(delay)&&delay>0?delay:null;
}

// Concurrent 429s can only extend the deadline. Commit it with the job's disposition.
export async function deferResend(db:PostgresJsDatabase,delay:number){
  await db.insert(cooldown).values({provider:'resend',until:sql`${clock}+${delay}::bigint`})
    .onConflictDoUpdate({target:cooldown.provider,set:{until:sql`greatest(${cooldown.until},excluded.until_ms)`}});
}
