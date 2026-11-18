import {eq,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {loginAttemptUses as attempts,requestBudgets as budgets,type BudgetScope} from './rate-limit-schema';

const minute=sql<number>`floor(extract(epoch from clock_timestamp())/60)::integer`;

export async function consumeBudget(db:PostgresJsDatabase,scope:BudgetScope,subject:string,limit:number){
  const rows=await db.insert(budgets).values({scope,subject,minute,used:1})
    .onConflictDoUpdate({
      target:[budgets.scope,budgets.subject],
      set:{
        minute:sql`greatest(${budgets.minute},excluded.minute)`,
        used:sql`case when ${budgets.minute}<excluded.minute then 1 else ${budgets.used}+1 end`,
      },
      setWhere:sql`${budgets.minute}<excluded.minute OR ${budgets.used}<${limit}`,
    }).returning({used:budgets.used});
  return rows.length===1;
}

export function admitLoginCallback(db:PostgresJsDatabase,stateHash:string,limit:number){
  return db.transaction(async tx=>{
    // A state is authenticated before admission. Keep the receipt beyond the ten-minute cookie window.
    const rows=await tx.insert(attempts).values({stateHash,expiresMinute:sql`${minute}+15`})
      .onConflictDoNothing().returning({stateHash:attempts.stateHash});
    if(!rows.length)return 'used';
    if(!await consumeBudget(tx,'login_callback','',limit)){
      await tx.delete(attempts).where(eq(attempts.stateHash,stateHash));
      return 'limited';
    }
    // Remove up to one minute of receipts per successful call, without contending on live claims.
    await tx.execute(sql`DELETE FROM ${attempts} WHERE state_hash IN (
      SELECT state_hash FROM ${attempts} WHERE expires_minute<=${minute}
      ORDER BY expires_minute LIMIT 60 FOR UPDATE SKIP LOCKED
    )`);
    return 'ok';
  });
}
