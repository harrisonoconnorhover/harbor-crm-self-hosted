import {readMigrationFiles} from 'drizzle-orm/migrator';
import {portableMaintenanceLock} from './portable-config.mjs';

export function readPortableMigrations(folder){
  const migrations=readMigrationFiles({migrationsFolder:folder});
  if(!migrations.length||migrations.some((entry,index)=>!Number.isSafeInteger(entry.folderMillis)||
    entry.folderMillis<=(migrations[index-1]?.folderMillis??0))){
    throw Error('Harbor’s migration files have an invalid order.');
  }
  return migrations;
}

export function comparePortableMigrationHistory(receipts,migrations){
  const applied=Math.min(receipts.length,migrations.length);
  for(let index=0;index<applied;index++){
    if(receipts[index].at!==migrations[index].folderMillis||receipts[index].sha256!==migrations[index].hash){
      return {status:'migration_history_mismatch',applied};
    }
  }
  if(receipts.length>migrations.length){
    const later=receipts[migrations.length].at;
    return {status:later>migrations.at(-1).folderMillis?'newer_release_required':'migration_history_mismatch',applied};
  }
  return {status:applied===migrations.length?'ok':'migration_required',applied};
}

export async function portableMigrationHistory(db,migrations){
  const [{ledger,encoding,version}]=await db`SELECT to_regclass('drizzle.__drizzle_migrations') AS ledger,
    current_setting('server_encoding') AS encoding,current_setting('server_version_num')::int AS version`;
  if(version<180000)return {status:'unsupported_database_version',applied:0,receipts:[]};
  if(encoding!=='UTF8')return {status:'unsupported_database_encoding',applied:0,receipts:[]};
  const receipts=ledger?await db`SELECT hash AS sha256,created_at::float8 AS at FROM drizzle.__drizzle_migrations
    ORDER BY id LIMIT ${migrations.length+1}`:[];
  return {...comparePortableMigrationHistory(receipts,migrations),receipts};
}

// Respect a database administrator's configured wait. PostgreSQL's default zero waits forever.
async function setMigrationLockWait(tx){
  await tx`SELECT set_config('lock_timeout','5s',true) WHERE current_setting('lock_timeout')='0'`;
}

export async function applyPortableMigrations(db,migrations){
  const current=await db.begin('read only',async tx=>{
    await setMigrationLockWait(tx);
    const [{locked}]=await tx`SELECT pg_try_advisory_xact_lock_shared(${portableMaintenanceLock}) AS locked`;
    if(!locked)return 'maintenance_in_progress';
    return (await portableMigrationHistory(tx,migrations)).status;
  });
  if(current!=='migration_required')return current;

  return db.begin(async tx=>{
    await setMigrationLockWait(tx);
    const [{locked}]=await tx`SELECT pg_try_advisory_xact_lock(${portableMaintenanceLock}) AS locked`;
    if(!locked)return 'maintenance_in_progress';
    const {status,applied}=await portableMigrationHistory(tx,migrations);
    if(status!=='migration_required')return status;

    await tx`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await tx`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    )`;
    for(const {sql,hash,folderMillis} of migrations.slice(applied)){
      for(const statement of sql)await tx.unsafe(statement);
      await tx`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES (${hash},${folderMillis})`;
    }
    return 'ok';
  });
}
