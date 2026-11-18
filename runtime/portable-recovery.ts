import {portableBackupMaxAgeHours,portableMaintenanceLock,portableStorageEndpoint} from './portable-config.mjs';
import {execFile} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {constants,createReadStream} from 'node:fs';
import {access,link,mkdir,mkdtemp,open,readFile,readdir,rename,rm,rmdir,stat,statfs,writeFile} from 'node:fs/promises';
import {createConnection,type Socket} from 'node:net';
import {devNull,tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {comparePortableMigrationHistory,portableMigrationHistory,readPortableMigrations} from './portable-migrations.mjs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {promisify} from 'node:util';
import postgres,{type TransactionSql} from 'postgres';
import {z} from 'zod';
import {MAX_ATTACHMENT_BYTES} from '../lib/activity-attachments';
import {fileDigest,objectBucketIsEmpty,objectStorageConfigured,privateObjectSize,readPrivateObject,writePrivateObject} from './portable-object-storage';
import {readPortableDatabaseStatus} from './portable-database-status';

type BackupIssue='invalid_directory'|'invalid_bundle'|'source_unverified'|'source_mismatch'|
  'backup_stale'|'backup_missing'|'capture_failed'|'integrity_failed'|'low_free_space'|'incompatible_migrations'|
  'backup_service_not_reporting'|'backup_service_poll_failed';
export class RecoveryFailure extends Error {
  constructor(message:string,readonly issue?:BackupIssue){super(message);}
}

const exec=promisify(execFile);
const pgToolEnv=()=>({NODE_ENV:process.env.NODE_ENV,PATH:process.env.PATH,LANG:process.env.LANG});

export async function checkPostgresTool(tool:'pg_dump'|'pg_restore'|'psql',databaseMajor?:number){
  try{
    const {stdout}=await exec(tool,['--version'],{env:pgToolEnv(),timeout:3000});
    const prefix=tool+' (PostgreSQL) ';
    const major=Number(stdout.startsWith(prefix)?stdout.slice(prefix.length).match(/^\d+/)?.[0]:undefined);
    if(databaseMajor&&major>0&&major<databaseMajor)return 'older_than_database';
    return major>=18?'ok':'unsupported_version';
  }catch{return 'unavailable';}
}
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const entry=z.object({
  key:z.string().regex(new RegExp('^contact-files(?:/'+uuid+'){4}$')),
  size:z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  sha256:digest,
}).strict();
const format='harbor-portable-recovery-v2';
const migrationReceipt=z.object({at:z.number().int().positive(),sha256:digest}).strict();
const manifestSchema=z.object({format:z.enum(['harbor-portable-recovery-v1',format]),dumpSha256:digest,files:z.array(entry),
  migrations:z.array(migrationReceipt).min(1).optional(),completedAt:z.number().int().positive().optional(),
  sourceId:z.string().guid("Invalid uuid").optional()}).strict()
  .refine(value=>(value.format===format)===(value.migrations!==undefined)&&(!value.sourceId||value.format===format));
const migrations=readPortableMigrations(fileURLToPath(new URL('../../../db/postgres/migrations',import.meta.url)));
const backupDay=/^\d{4}-\d{2}-\d{2}$/;
const backupFailurePrefix='.harbor-backup-failed-';
const backupServicePollMarker='.harbor-backup-service-poll';
const failedBackupServicePoll='failed\n';
const sourceMarker='.harbor-backup-source';
const captureMarker='capture-started-at';
const dumpSizeMarker='database-dump-size';
const sourceMarkerValue=new RegExp('^'+uuid+'\\n$');
const hourMs=60*60*1000;
const backupSampleChecksumBudget=8*1024*1024;
type Entry=z.infer<typeof entry>;
type Manifest=z.infer<typeof manifestSchema>;
type Sql=ReturnType<typeof postgres>;
type DatabaseReply=<T>(read:()=>PromiseLike<T>)=>Promise<T>;
const recoveryConnectSeconds=10;
const recoveryReplyDeadlineMs=5_000;
const restoreUnconfirmed='Harbor could not confirm the database restore. Keep the target stopped and inspect the database and bucket before retrying.';

async function fileHash(path:string,end?:number){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path,{end}))hash.update(chunk);
  return hash.digest('hex');
}

function recoveryDatabase(url:URL){
  const database=decodeURIComponent(url.pathname.slice(1));
  const ssl=url.searchParams.getAll('sslmode');
  if(!/^[a-zA-Z0-9_-]+$/.test(database)||url.hostname.includes(',')||url.hash||url.searchParams.size!==ssl.length||
    ssl.length>1||ssl.some(mode=>!['disable','prefer','require','verify-full'].includes(mode))){
    throw new RecoveryFailure('Use a named Postgres database with an optional supported sslmode.');
  }
  return {database,host:url.hostname.replace(/^\[|\]$/g,''),port:Number(url.port||'5432'),sslmode:ssl[0]};
}

function recoveryControlConnection(url:URL){
  const {host,port}=recoveryDatabase(url);
  let socket:Socket|undefined;
  const options={max:1,connect_timeout:recoveryConnectSeconds,idle_timeout:0,max_lifetime:0,onnotice:()=>{},socket:()=>{
    // Keep the driver's host metadata for TLS server-name verification.
    socket=Object.assign(createConnection({host,port}),{host,port});
    return socket;
  }};
  const db=postgres(url.href,options);
  return {db,async close(){
    try{await db.end({timeout:0});}
    finally{
      // Let Postgres.js close its TLS wrapper before destroying the underlying socket.
      // A broken peer can leave the socket open even after the driver's deadline.
      socket?.destroy();
    }
  }};
}

async function recoveryDatabaseReply<T>(read:()=>PromiseLike<T>,message:string,timeout=recoveryReplyDeadlineMs):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const deadline=new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new RecoveryFailure(message)),timeout);
    });
    return await Promise.race([read(),deadline]);
  }finally{clearTimeout(timer);}
}

async function pg(tool:'pg_dump'|'psql',url:URL,args:string[]){
  const {database,host,port,sslmode}=recoveryDatabase(url);
  try{
    return await exec(tool,['--dbname',database,'--no-password',...args],{env:{...pgToolEnv(),
      PGHOST:host,PGPORT:String(port),PGCONNECT_TIMEOUT:'10',
      PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),
      ...(sslmode?{PGSSLMODE:sslmode}:{}),
      ...(sslmode==='verify-full'?{PGSSLROOTCERT:process.env.PGSSLROOTCERT}:{}),
    },timeout:600_000});
  }catch(error){
    if(tool==='psql'){
      const stderr=typeof error==='object'&&error&&'stderr' in error&&typeof error.stderr==='string'?error.stderr:'';
      if(/\bHBR01: Restored file receipts do not match the backup manifest\./.test(stderr)){
        throw new RecoveryFailure('Restored file receipts do not match the backup manifest.');
      }
      if(/\bHBR02:/.test(stderr)){
        throw new RecoveryFailure('Could not verify that both Postgres clients reached the same restore target.');
      }
      if(/\bHBR03:/.test(stderr)){
        throw new RecoveryFailure('Restored migration receipts do not match the Harbor release or backup manifest.');
      }
      // A lost connection can hide the COMMIT response after PostgreSQL has persisted the import.
      throw new RecoveryFailure(restoreUnconfirmed);
    }
    throw new RecoveryFailure(tool+' failed. Check the local Postgres version, permissions and connectivity.');
  }
}

// Older migration prefixes can be backed up or restored before adding the
// optional storage owner column. Row JSON returns null when that key is absent.
const committedFileKey = `'contact-files/' || workspace_id || '/' ||
      coalesce(to_jsonb(file)->>'storage_contact_id', contact_id::text) || '/' || file_id || '/' || version_id`;

const omittedPublicTableData=[
  'login_sessions','portable_google_attempts','portable_google_grants','portable_request_budgets',
  'portable_workspace_viewers','portable_api_tokens','portable_workspace_invites','portable_lead_form_activations',
  'portable_published_availability','portable_guest_booking_requests','portable_worker_heartbeat',
  'portable_workflow_activations','portable_backup_source','portable_segment_workflow_scans','portable_segment_workflow_members',
];

async function backupReadPermissions(db:Sql,databaseMajor:number){
  // pg_dump locks table definitions even where table data is omitted.
  const lockPrivileges='SELECT, INSERT, UPDATE, DELETE, TRUNCATE'+(databaseMajor>=17?', MAINTAIN':'');
  const [{allowed}]=await db`SELECT NOT EXISTS (
    SELECT FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS schema ON schema.oid=relation.relnamespace
    WHERE schema.nspname IN ('public','drizzle') AND relation.relkind IN ('r','p','S')
      AND (NOT has_schema_privilege(schema.oid,'USAGE') OR CASE WHEN relation.relkind='S'
        THEN NOT has_sequence_privilege(relation.oid,'SELECT')
        ELSE NOT has_table_privilege(relation.oid,${lockPrivileges})
          OR (relation.relkind='r' AND NOT (schema.nspname='public' AND relation.relname::text=ANY(${db.array(omittedPublicTableData)}::text[]))
            AND (row_security_active(relation.oid) OR EXISTS (
              SELECT FROM pg_catalog.pg_attribute AS column_info
              WHERE column_info.attrelid=relation.oid AND column_info.attnum>0
                AND NOT column_info.attisdropped AND column_info.attgenerated=''
                AND NOT has_column_privilege(relation.oid,column_info.attnum,'SELECT')
            )))
      END)
  ) AS allowed`;
  return allowed;
}

async function* committedVersions(db:Sql|TransactionSql,reply:DatabaseReply){
  const rows=db.unsafe(`SELECT ${committedFileKey} AS key,
      size, sha256 FROM public.contact_file_versions AS file WHERE revision IS NOT NULL
      ORDER BY workspace_id,contact_id,file_id,version_id`);
  const cursor=rows.cursor(100)[Symbol.asyncIterator]();
  try{
    for(;;){
      const batch=await reply(()=>cursor.next());
      if(batch.done)return;
      for(const row of batch.value)yield entry.parse(row);
    }
  }finally{await cursor.return?.();}
}

async function sampleCommittedVersion(db:Sql){
  const [sample]=await db.unsafe<Entry[]>(`SELECT ${committedFileKey} AS key, size, sha256
    FROM public.contact_file_versions AS file WHERE revision IS NOT NULL LIMIT 1`);
  return sample;
}

async function writeBundle(tx:Sql|TransactionSql,url:URL,directory:string,captureStartedAt:number,sourceId:string|undefined,reply:DatabaseReply){
  const {status,applied,receipts}=await reply(()=>portableMigrationHistory(tx,migrations));
  if(!applied||!['ok','migration_required'].includes(status)){
    throw new RecoveryFailure('The source database migration history differs from this Harbor release.');
  }
  const objects=join(directory,'objects'),dump=join(directory,'database.dump');
  await mkdir(directory,{mode:0o700});
  await mkdir(objects,{mode:0o700});
  const files:Entry[]=[];
  const [{snapshot}]=await reply(()=>tx.unsafe<{snapshot:string}[]>('SELECT pg_export_snapshot() AS snapshot'));
  await pg('pg_dump',url,['--format=custom','--no-owner','--no-privileges',
    ...omittedPublicTableData.map(table=>'--exclude-table-data=public.'+table),
    '--snapshot',snapshot,'--file',dump]);
  for await(const version of committedVersions(tx,reply)){
    const bytes=await readPrivateObject(version.key,version).catch(()=>{
      throw new RecoveryFailure('Could not read or verify a committed attachment. Check the backup service’s private bucket access and the source file.');
    });
    await writeFile(join(objects,version.sha256),bytes,{mode:0o600});
    files.push(version);
  }
  const {size:dumpSize}=await stat(dump);
  if(!Number.isSafeInteger(dumpSize)||dumpSize<1)throw new RecoveryFailure('The database dump size is invalid.');
  const manifest={format,dumpSha256:await fileHash(dump),files,migrations:receipts,completedAt:Date.now(),sourceId};
  // Keep the existing manifest readable by older restore tools.
  await writeFile(join(directory,captureMarker),new Date(captureStartedAt).toISOString()+'\n',{mode:0o600,flag:'wx'});
  await writeFile(join(directory,dumpSizeMarker),dumpSize+'\n',{mode:0o600,flag:'wx'});
  await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
  return files.length;
}

async function backup(url:URL,directory:string){
  const destination=resolve(directory);
  const {db,close}=recoveryControlConnection(url);
  const reply=<T>(read:()=>PromiseLike<T>,timeout?:number)=>
    recoveryDatabaseReply(read,'A backup database reply timed out. The recovery point was not published.',timeout);
  const captureStartedAt=Date.now();
  let staging:string|undefined;
  try{
    const tx=await reply(()=>db.reserve(),recoveryConnectSeconds*1_000);
    await reply(()=>tx.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    const [{locked}]=await reply(()=>tx.unsafe<{locked:boolean}[]>('SELECT pg_try_advisory_xact_lock_shared($1) AS locked',[portableMaintenanceLock]));
    if(!locked)throw new RecoveryFailure('Another Harbor command holds the database maintenance lock. Retry after it finishes.');
    staging=await mkdtemp(join(dirname(destination),'.harbor-staging-'));
    const bundle=join(staging,'bundle');
    const versions=await writeBundle(tx,url,bundle,captureStartedAt,undefined,reply);
    await reply(()=>tx.unsafe('COMMIT'));
    // Reserve a new path after capture to avoid overwriting any existing destination.
    await mkdir(destination,{mode:0o700});
    try{await rename(bundle,destination);}
    catch(error){await rmdir(destination).catch(()=>{});throw error;}
    return {versions,held:0};
  }finally{
    try{await close();}
    finally{if(staging)await rm(staging,{recursive:true,force:true});}
  }
}

async function privateBackupRoot(root:string){
  if(!isAbsolute(root))throw new RecoveryFailure('Use an absolute private backup directory.','invalid_directory');
  const info=await stat(root);
  if(!info.isDirectory()||(info.mode&0o077)!==0)throw new RecoveryFailure('Use an existing backup directory with owner-only permissions.','invalid_directory');
}

async function readManifest(directory:string):Promise<Manifest>{
  return manifestSchema.parse(JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')));
}

function missingPath(error:unknown){
  return error instanceof Error&&'code' in error&&['ENOENT','ENOTDIR'].includes(String(error.code));
}

async function backupCaptureTime(directory:string,completedAt:number){
  const path=join(directory,captureMarker);
  const capture=await stat(path).catch(error=>{
    if(missingPath(error))return null;
    throw error;
  });
  if(!capture)return {captureStartedAt:completedAt,hasCaptureStart:false};
  if(!capture.isFile()||capture.size!==25)throw new RecoveryFailure('The backup capture time is invalid.','invalid_bundle');
  const value=await readFile(path,'utf8'),captureStartedAt=Date.parse(value.slice(0,-1));
  if(!Number.isFinite(captureStartedAt)||new Date(captureStartedAt).toISOString()+'\n'!==value||captureStartedAt>completedAt){
    throw new RecoveryFailure('The backup capture time is invalid.','invalid_bundle');
  }
  return {captureStartedAt,hasCaptureStart:true};
}

async function publishedBackup(directory:string){
  try{
    const manifest=await readManifest(directory);
    const dump=await stat(join(directory,'database.dump'));
    if(!manifest.completedAt||!dump.isFile()||dump.size===0){
      throw new RecoveryFailure('The completed backup directory is incomplete.','invalid_bundle');
    }
    // Older bundles have no size marker. Their full checksum still verifies the dump.
    const sizePath=join(directory,dumpSizeMarker);
    const sizeMarker=await stat(sizePath).catch(error=>{
      if(missingPath(error))return null;
      throw error;
    });
    const sizeText=dump.size+'\n';
    if(sizeMarker&&(!sizeMarker.isFile()||sizeMarker.size!==sizeText.length||await readFile(sizePath,'utf8')!==sizeText)){
      throw new RecoveryFailure('Database dump size does not match the saved backup size.','integrity_failed');
    }
    const capture=await backupCaptureTime(directory,manifest.completedAt);
    return {...manifest,completedAt:manifest.completedAt,...capture,dumpSize:dump.size};
  }catch(error){
    if(missingPath(error)||error instanceof SyntaxError||error instanceof z.ZodError){
      throw new RecoveryFailure('The completed backup directory is incomplete or its manifest is invalid.','invalid_bundle');
    }
    throw error;
  }
}

async function backupSource(db:Sql|TransactionSql){
  try{
    const [{source_id:sourceId}={}]=await db.unsafe<{source_id:string}[]>('SELECT source_id FROM public.portable_backup_source');
    if(!sourceId)throw new RecoveryFailure('The database has no Harbor backup source identity. Check its migrations.','source_unverified');
    return sourceId;
  }catch(error){
    if(error instanceof Error&&'code' in error&&error.code==='42P01'){
      throw new RecoveryFailure('Apply Harbor database migrations before checking scheduled backups.','source_unverified');
    }
    throw error;
  }
}

async function readBackupRootSource(root:string){
  const marker=join(root,sourceMarker);
  try{
    const info=await stat(marker);
    if(info.isFile()&&info.size===37){
      const value=await readFile(marker,'utf8');
      if(sourceMarkerValue.test(value))return value.slice(0,-1);
    }
    throw new RecoveryFailure('The private backup root source marker is invalid.','source_unverified');
  }catch(error){
    if(missingPath(error))return null;
    throw error;
  }
}

async function requireBackupRootSource(root:string,sourceId:string,initialize=false){
  let saved=await readBackupRootSource(root);
  if(!saved&&initialize&&!(await readdir(root)).some(name=>backupDay.test(name))){
    const staging=await mkdtemp(join(root,'.harbor-staging-'));
    const marker=join(staging,sourceMarker);
    try{
      await writeFile(marker,sourceId+'\n',{mode:0o600});
      // Publish the complete marker atomically, without replacing a competing source.
      await link(marker,join(root,sourceMarker)).catch(error=>{if(error.code!=='EEXIST')throw error;});
    }finally{await rm(staging,{recursive:true,force:true});}
    saved=await readBackupRootSource(root);
  }
  if(!saved)throw new RecoveryFailure('The backup root has no verified source. Use a new empty private backup root.','source_unverified');
  if(saved!==sourceId)throw new RecoveryFailure('The private backup root belongs to a different Harbor database.','source_mismatch');
}

function requireBundleSource(manifest:Manifest,sourceId:string){
  if(manifest.sourceId!==sourceId)throw new RecoveryFailure('The scheduled backup bundle does not match its Harbor database.','source_mismatch');
}

function requireFreshBackup(manifest:{completedAt:number;captureStartedAt:number},maxAgeHours=portableBackupMaxAgeHours){
  const now=Date.now();
  if(manifest.completedAt>now||now-manifest.captureStartedAt>maxAgeHours*hourMs){
    throw new RecoveryFailure('The latest scheduled Harbor backup is overdue or its clock is invalid.','backup_stale');
  }
}

export async function portableBackupPreflight(root:string,database:()=>URL,mode:'local'|'hosted'){
  const checks={directory:'unavailable',database:'unavailable',storage:'unavailable',dumpTool:'unavailable'};
  let sourceId:string|undefined;
  let sample:Entry|undefined;
  let databaseMajor:number|undefined;
  try{
    const url=database();
    recoveryDatabase(url);
    const result=await readPortableDatabaseStatus(url,async db=>{
      const {status,applied}=await portableMigrationHistory(db,migrations);
      if(!applied||!['ok','migration_required'].includes(status))return {status};
      const sourceId=await backupSource(db);
      const sample=await sampleCommittedVersion(db);
      const [{major}]=await db`SELECT current_setting('server_version_num')::int / 10000 AS major`;
      const allowed=await backupReadPermissions(db,major);
      return {status:allowed?'ok':'missing_backup_permissions',sourceId,sample,major};
    });
    checks.database=result.status;
    ({sourceId,sample,major:databaseMajor}=result);
  }catch{}
  await Promise.all([
    (async()=>{
      try{
        await privateBackupRoot(root);
        await access(root,constants.R_OK|constants.W_OK|constants.X_OK);
        const saved=await readBackupRootSource(root);
        if(saved)checks.directory=!sourceId?'source_unverified':saved===sourceId?'ok':'wrong_source';
        else checks.directory=(await readdir(root)).some(name=>backupDay.test(name))?'unbound_existing_backups':'ok';
      }catch(error){checks.directory=error instanceof RecoveryFailure?'invalid_private_directory':'unavailable';}
    })(),
    (async()=>{
      if(!objectStorageConfigured()){checks.storage='missing_storage_settings';return;}
      try{portableStorageEndpoint(process.env,mode);}
      catch{checks.storage='invalid_storage_endpoint';return;}
      if(!sample){checks.storage=checks.database==='ok'?'no_files_to_check':'source_unverified';return;}
      try{await readPrivateObject(sample.key,sample);checks.storage='ok';}
      catch{}
    })(),
    (async()=>{
      checks.dumpTool=await checkPostgresTool('pg_dump',databaseMajor);
    })(),
  ]);
  const setupPassed=Object.values(checks).every(value=>value==='ok'||value==='no_files_to_check');
  const result=!setupPassed?'needs_setup':checks.storage==='no_files_to_check'?'ready_for_file_test':'ready';
  return {profile:'backup',result,backupEnabled:process.env.HARBOR_PORTABLE_BACKUP_ENABLED==='true',checks,
    ...(result==='ready_for_file_test'?{nextStep:'Upload a fictional Contact attachment, then run doctor backup again.'}:{})};
}

async function requireBackupFreeSpace(root:string,minFreeMiB:number){
  if(!minFreeMiB)return;
  const minimumBytes=BigInt(minFreeMiB)*BigInt(1_048_576);
  const {bsize,bavail}=await statfs(root,{bigint:true});
  if(bsize*bavail<minimumBytes)throw new RecoveryFailure('The backup volume has less free space than configured.','low_free_space');
}

export async function runPortableBackupTick(url:URL,root:string,minFreeMiB=0){
  process.umask(0o077);
  await privateBackupRoot(root);
  const {db,close}=recoveryControlConnection(url);
  let staging:string|undefined;
  const reply=<T>(read:()=>PromiseLike<T>,timeout?:number)=>
    recoveryDatabaseReply(read,'A scheduled backup database reply timed out. The backup will retry.',timeout);
  try{
    const tx=await reply(()=>db.reserve(),recoveryConnectSeconds*1_000);
    // Share the worker's maintenance lock through backup publication.
    const [{locked:maintenanceReady}]=await reply(()=>tx<{locked:boolean}[]>`
      SELECT pg_try_advisory_lock_shared(${portableMaintenanceLock}) AS locked`);
    if(!maintenanceReady)return {result:'busy'};
    const captureStartedAt=Date.now();
    await reply(()=>tx.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    // Hold the same advisory lock through publication, even after the snapshot transaction ends.
    const [{locked,day}]=await reply(()=>tx.unsafe<{locked:boolean;day:string}[]>(`SELECT pg_try_advisory_lock(943157311) AS locked,
      to_char(current_timestamp AT TIME ZONE 'UTC','YYYY-MM-DD') AS day`));
    if(!locked)return {result:'busy'};
    const sourceId=await reply(()=>backupSource(tx));
    await requireBackupRootSource(root,sourceId,true);
    const destination=join(root,day);
    const existing=await stat(destination).catch(error=>{
      if(error.code==='ENOENT')return null;
      throw error;
    });
    if(existing){
      const manifest=await publishedBackup(destination);
      requireBundleSource(manifest,sourceId);
      requireFreshBackup(manifest);
      requireCompatibleBackupMigrations(backupMigrationHistory(manifest));
      await checkBackupSample(destination,manifest);
      const sample=await reply(()=>sampleCommittedVersion(tx));
      if(sample){
        const size=await privateObjectSize(sample.key).catch(()=>undefined);
        if(size!==sample.size){
          throw new RecoveryFailure('Could not verify a committed attachment in the source bucket. Check backup storage access and the source file.');
        }
      }
      await reply(()=>tx.unsafe('COMMIT'));
      return {result:'already_complete',day};
    }
    const failure=join(root,backupFailurePrefix+day);
    let versions;
    try{
      await requireBackupFreeSpace(root,minFreeMiB);
      staging=await mkdtemp(join(root,'.harbor-staging-'));
      const bundle=join(staging,'bundle');
      versions=await writeBundle(tx,url,bundle,captureStartedAt,sourceId,reply);
      await reply(()=>tx.unsafe('COMMIT'));
      // Publish only a complete bundle on the same filesystem. Never replace a verified day.
      await rename(bundle,destination);
    }catch(error){
      // The date is the only saved detail. If the lock was lost and a competing
      // capture already published this day, its complete bundle takes precedence.
      await writeFile(failure,'',{flag:'wx',mode:0o600}).catch(()=>{});
      if(typeof error==='object'&&error!==null&&'code' in error&&['ENOSPC','EDQUOT'].includes(String(error.code))){
        throw new RecoveryFailure('The backup volume ran out of space or reached its quota during capture. Check available space and retry.','low_free_space');
      }
      throw error;
    }
    await rm(failure,{force:true}).catch(()=>{});
    return {result:'complete',day,versions};
  }finally{
    try{await close();}
    finally{if(staging)await rm(staging,{recursive:true,force:true});}
  }
}

export async function listPortableRecoveryPoints(root:string){
  await privateBackupRoot(root);
  const entries=await readdir(root,{withFileTypes:true});
  const days=entries.filter(entry=>entry.isDirectory()&&backupDay.test(entry.name))
    .map(entry=>entry.name).sort().reverse();
  const points=[];
  for(const day of days.slice(0,15)){
    try{
      const manifest=await publishedBackup(join(root,day));
      points.push({day,status:'metadata_readable',captureStartedAt:manifest.captureStartedAt,
        completedAt:manifest.completedAt,migrationHistory:backupMigrationHistory(manifest)});
    }catch(error){
      points.push({day,status:'unavailable',issue:error instanceof RecoveryFailure?error.issue:undefined});
    }
  }
  return {result:'listed',points,hasOlder:days.length>points.length};
}

export async function recordBackupServicePoll(root:string,result:'succeeded'|'failed'){
  try{
    await privateBackupRoot(root);
    const staging=await mkdtemp(join(root,'.harbor-staging-'));
    const marker=join(staging,backupServicePollMarker);
    try{
      await writeFile(marker,result==='failed'?failedBackupServicePoll:'',{mode:0o600,flag:'wx'});
      await rename(marker,join(root,backupServicePollMarker));
    }finally{await rm(staging,{recursive:true,force:true});}
  }catch{
    throw new RecoveryFailure('Could not save the backup service poll. Check backup volume permissions and free space.');
  }
}

async function requireBackupServicePoll(root:string){
  const marker=await open(join(root,backupServicePollMarker),constants.O_RDONLY|constants.O_NONBLOCK).catch(error=>{
    if(missingPath(error))return null;
    throw error;
  });
  if(marker){
    try{
      // Inspect the same inode throughout so an atomic update cannot mix the outcome and timestamp.
      const info=await marker.stat(),age=Date.now()-info.mtimeMs;
      if(info.isFile()&&age>=0){
        if(info.size===0&&age<2*hourMs)return;
        if(info.size===failedBackupServicePoll.length){
          const content=Buffer.alloc(failedBackupServicePoll.length);
          const {bytesRead}=await marker.read(content);
          if(bytesRead===content.length&&content.toString()===failedBackupServicePoll){
            throw new RecoveryFailure('The latest backup service poll failed. Check the backup service logs.','backup_service_poll_failed');
          }
        }
      }
    }finally{await marker.close();}
  }
  throw new RecoveryFailure('The backup service has no recent successful poll. Check that the service is running.','backup_service_not_reporting');
}

export async function portableBackupStatus(root:string,verify=false,database?:()=>URL,maxAgeHours=portableBackupMaxAgeHours,minFreeMiB=0,selectedDay?:string,expectBackupService=false){
  await privateBackupRoot(root);
  const entries=await readdir(root,{withFileTypes:true});
  const days=entries.filter(entry=>entry.isDirectory()&&backupDay.test(entry.name)).map(entry=>entry.name);
  const day=selectedDay?days.find(value=>value===selectedDay):days.sort().at(-1);
  const failedCapture=!selectedDay&&(database||!verify||!day)&&entries.some(entry=>{
    if(!entry.isFile()||!entry.name.startsWith(backupFailurePrefix))return false;
    const failedDay=entry.name.slice(backupFailurePrefix.length);
    return backupDay.test(failedDay)&&(!day||failedDay>day);
  });
  if(!day){
    if(!selectedDay)await requireBackupFreeSpace(root,minFreeMiB);
    if(failedCapture)throw new RecoveryFailure('The first scheduled Harbor backup failed. Check the backup service and retry the capture.','capture_failed');
    throw new RecoveryFailure(selectedDay?'No scheduled Harbor backup was found for that date.':
      'No completed scheduled Harbor backup was found.','backup_missing');
  }
  const directory=join(root,day),manifest=await publishedBackup(directory);
  // An explicitly selected recovery point may be old. Routine status still checks freshness.
  const migrationHistory=backupMigrationHistory(manifest);
  if(!selectedDay){
    requireFreshBackup(manifest,maxAgeHours);
    requireCompatibleBackupMigrations(migrationHistory);
  }
  if(database){
    const sourceId=await readPortableDatabaseStatus(database(),backupSource);
    await requireBackupRootSource(root,sourceId);
    requireBundleSource(manifest,sourceId);
  }
  await requireBackupFreeSpace(root,minFreeMiB);
  // Offline full verification can still inspect a completed point after a later failure.
  if(failedCapture)throw new RecoveryFailure('A newer scheduled Harbor backup failed. Check the backup service and retry the capture.','capture_failed');
  if(expectBackupService)await requireBackupServicePoll(root);
  const capturePoint={day,versions:manifest.files.length,
    ...(manifest.hasCaptureStart?{captureStartedAt:manifest.captureStartedAt}:{})};
  if(verify){
    await verifyBackupContents(directory,manifest);
    return {result:'verified',...capturePoint,
      ...(selectedDay?{captureStartedAt:manifest.captureStartedAt,completedAt:manifest.completedAt,
        migrationHistory}:{})};
  }
  await checkBackupSample(directory,manifest);
  return {result:'fresh',...capturePoint};
}

async function checkBackupSample(directory:string,{files,dumpSize,dumpSha256}:Manifest&{dumpSize:number}){
  const sample=files.length<=10?files:[...files.slice(0,5),...files.slice(-5)];
  let remaining=backupSampleChecksumBudget;
  async function checkChecksum(path:string,size:number,digest:string,mismatch:string){
    // Include one byte beyond the expected EOF to catch growth after stat.
    if(size>=remaining)return;
    remaining-=size+1;
    const hash=await fileHash(path,size).catch(()=>{throw new RecoveryFailure(mismatch,'integrity_failed');});
    if(hash!==digest)throw new RecoveryFailure(mismatch,'integrity_failed');
  }
  const checked=new Set<string>();
  for(const version of sample){
    const path=await checkBackupVersionSize(directory,version);
    if(checked.has(version.sha256))continue;
    checked.add(version.sha256);
    await checkChecksum(path,version.size,version.sha256,'Backup file does not match its manifest.');
  }
  await checkChecksum(join(directory,'database.dump'),dumpSize,dumpSha256,'Database dump does not match its manifest.');
}

async function checkBackupVersionSize(directory:string,version:Entry){
  const path=join(directory,'objects',version.sha256);
  const info=await stat(path).catch(()=>{throw new RecoveryFailure('A backup file is missing or unreadable.','integrity_failed');});
  if(!info.isFile()||info.size!==version.size)throw new RecoveryFailure('Backup file size does not match its manifest.','integrity_failed');
  return path;
}

async function readVersion(directory:string,version:Entry){
  const path=await checkBackupVersionSize(directory,version);
  const bytes=await readFile(path).catch(()=>{throw new RecoveryFailure('A backup file is missing or unreadable.','integrity_failed');});
  if(bytes.length!==version.size||fileDigest(bytes)!==version.sha256)throw new RecoveryFailure('Backup file does not match its manifest.','integrity_failed');
  return bytes;
}

async function verifyBackupContents(directory:string,manifest:Manifest){
  if(await fileHash(join(directory,'database.dump'))!==manifest.dumpSha256)throw new RecoveryFailure('Database dump does not match its manifest.','integrity_failed');
  const keys=new Set<string>();
  for(const version of manifest.files){
    if(keys.has(version.key))throw new RecoveryFailure('Duplicate file key in backup manifest.','invalid_bundle');
    keys.add(version.key);
    await readVersion(directory,version);
  }
}

function restoreFinalization(manifest:Manifest){
  // Manifest keys and digests are restricted to lowercase hex and fixed separators before reaching COPY.
  const receipts=manifest.files.map(file=>[file.key,file.size,file.sha256].join('\t')).join('\n');
  // The packaged journal is ordered and its hashes come from Drizzle's SHA-256 reader.
  const expected=migrations.map(({folderMillis,hash},index)=>`(${index+1},${folderMillis}::bigint,'${hash}')`).join(',');
  const count=manifest.migrations?` OR (SELECT count(*) FROM drizzle.__drizzle_migrations)<>${manifest.migrations.length}`:'';
  return `CREATE TEMP TABLE harbor_restore_files (key text PRIMARY KEY, size bigint, sha256 text) ON COMMIT DROP;
COPY harbor_restore_files (key, size, sha256) FROM STDIN;
${receipts?receipts+'\n':''}\\.
DO $harbor$
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='HBR03', MESSAGE='The archive has no Harbor migration ledger.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations)${count} OR EXISTS (
    SELECT 1 FROM (
      SELECT row_number() OVER (ORDER BY id) AS position, created_at, hash FROM drizzle.__drizzle_migrations
    ) actual LEFT JOIN (VALUES ${expected}) expected(position,created_at,hash) USING (position)
    WHERE expected.position IS NULL OR (actual.created_at,actual.hash) IS DISTINCT FROM (expected.created_at,expected.hash)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='HBR03', MESSAGE='Restored migration receipts do not match.';
  END IF;
  IF EXISTS (
    SELECT FROM harbor_restore_files expected
    FULL JOIN (
      SELECT ${committedFileKey} AS key,
        size, sha256 FROM public.contact_file_versions AS file WHERE revision IS NOT NULL
    ) restored USING (key)
    WHERE expected.size IS DISTINCT FROM restored.size OR expected.sha256 IS DISTINCT FROM restored.sha256
  ) THEN
    RAISE EXCEPTION USING ERRCODE='HBR01', MESSAGE='Restored file receipts do not match the backup manifest.';
  END IF;
  -- Backups exclude the installation identity. A restore starts a new backup lineage.
  IF to_regclass('public.portable_backup_source') IS NOT NULL THEN
    INSERT INTO public.portable_backup_source DEFAULT VALUES
      ON CONFLICT (singleton) DO UPDATE SET source_id=EXCLUDED.source_id;
  END IF;
  IF to_regclass('public.portable_calendar_meetings') IS NOT NULL THEN
    UPDATE public.portable_calendar_meetings SET status='attention' WHERE status='submitting';
    UPDATE public.portable_calendar_meetings SET status='cancel_attention' WHERE status='cancelling';
  END IF;
  IF to_regclass('public.portable_calendar_reschedules') IS NOT NULL THEN
    UPDATE public.portable_calendar_reschedules SET status='attention' WHERE status='submitting';
  END IF;
END;
$harbor$;

-- The source may have dispatched any of these jobs after the backup point.
WITH held_jobs AS (
  UPDATE public.portable_jobs SET status='attention', lease_token=NULL, lease_until=NULL,
    issue='restore_requires_reconciliation', finished_at=floor(extract(epoch from clock_timestamp())*1000)::bigint
  WHERE kind IN ('external','gmail') AND status IN ('queued','running','dispatching')
  RETURNING workspace_id,id,attempts,finished_at
), closed_attempts AS (
  UPDATE public.portable_job_attempts a SET ended_at=h.finished_at, outcome='restore_requires_reconciliation'
  FROM held_jobs h WHERE a.workspace_id=h.workspace_id AND a.job_id=h.id AND a.number=h.attempts AND a.ended_at IS NULL
)
SELECT 'harbor_held=' || count(*) FROM held_jobs;
`;
}

async function restoreDatabaseState(db:Sql|Awaited<ReturnType<Sql['reserve']>>){
  const [{populated,read_only,version,encoding,can_restore}]=await db`SELECT EXISTS (
      SELECT FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('public','information_schema') AND left(nspname,3) <> 'pg_'
      UNION ALL SELECT FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      UNION ALL SELECT FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      UNION ALL SELECT FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace
    ) AS populated, current_setting('transaction_read_only')='on' AS read_only,
    current_setting('server_version_num')::int AS version, current_setting('server_encoding') AS encoding,
    has_database_privilege(current_database(),'CREATE') AND has_database_privilege(current_database(),'TEMPORARY')
      AND has_schema_privilege('public','USAGE') AND has_schema_privilege('public','CREATE') AS can_restore`;
  if(populated)return 'not_empty';
  if(read_only)return 'read_only';
  if(version<180000)return 'unsupported_version';
  if(encoding!=='UTF8')return 'unsupported_encoding';
  if(!can_restore)return 'missing_restore_permissions';
  return 'ok';
}

function backupMigrationHistory(manifest:Manifest){
  return manifest.migrations?comparePortableMigrationHistory(manifest.migrations,migrations).status:'unrecorded';
}

function requireCompatibleBackupMigrations(status:ReturnType<typeof backupMigrationHistory>){
  if(status==='newer_release_required'||status==='migration_history_mismatch'){
    throw new RecoveryFailure('Backup migration history differs from this Harbor release.','incompatible_migrations');
  }
}

async function restoreManifest(directory:string){
  const manifest=await readManifest(directory);
  requireCompatibleBackupMigrations(backupMigrationHistory(manifest));
  return manifest;
}

async function decodeRestoreArchive(dump:string,destination:string){
  try{
    await exec('pg_restore',['--no-owner','--no-privileges','--file',destination,dump],
      {env:pgToolEnv(),timeout:600_000});
  }catch{throw new RecoveryFailure('pg_restore failed to read the verified archive. Check the local Postgres client version.');}
}

export async function portableRestorePreflight(database:()=>URL,checkArchive?:()=>Promise<string>){
  const [targetDb,storage,restoreTool,sqlTool]=await Promise.all([
    Promise.resolve().then(()=>{
      const url=database();
      recoveryDatabase(url);
      return readPortableDatabaseStatus(url,restoreDatabaseState);
    }).catch(()=> 'unavailable'),
    objectBucketIsEmpty().then(empty=>empty?'ok':'not_empty').catch(()=> 'unavailable'),
    checkPostgresTool('pg_restore'),
    checkPostgresTool('psql'),
  ]);
  const checks={database:targetDb,storage,restoreTool,sqlTool,...(checkArchive?{
    archive:restoreTool==='ok'?await checkArchive():'restore_tool_unavailable',
  }:{})};
  return {profile:'restore',result:Object.values(checks).every(value=>value==='ok')?'ready':'needs_setup',checks};
}

async function checkRestoreArchive(directory:string){
  let manifest;
  try{manifest=await restoreManifest(directory);}
  catch{return {status:'manifest_incompatible'} as const;}
  try{await decodeRestoreArchive(join(directory,'database.dump'),devNull);}
  catch{return {status:'archive_unreadable'} as const;}
  try{await verifyBackupContents(directory,manifest);}
  catch{return {status:'bundle_integrity_failed'} as const;}
  return {status:'ok',manifest} as const;
}

export async function portableRestoreArchiveStatus(directory:string){
  return (await checkRestoreArchive(directory)).status;
}

export async function portableBundleArchiveReport(directory:string){
  const profile='bundle';
  const archive=await checkRestoreArchive(directory);
  const checks={restoreTool:'ok',archive:archive.status};
  if(archive.status!=='ok')return {profile,result:'needs_setup',checks};
  const {manifest}=archive;
  let capture;
  try{
    if(manifest.completedAt!==undefined)capture=await backupCaptureTime(directory,manifest.completedAt);
  }catch{return {profile,result:'needs_setup',checks:{...checks,archive:'invalid_capture_time'}};}
  return {profile,result:'verified',checks,versions:manifest.files.length,dumpSha256:manifest.dumpSha256,
    migrationHistory:backupMigrationHistory(manifest),
    ...(capture?{captureStartedAt:capture.captureStartedAt,completedAt:manifest.completedAt}:{})};
}

async function restore(url:URL,directory:string){
  const dump=join(directory,'database.dump'),manifest=await restoreManifest(directory);
  await verifyBackupContents(directory,manifest);
  const {db,close}=recoveryControlConnection(url);
  const reply=<T>(read:()=>PromiseLike<T>,timeout?:number)=>
    recoveryDatabaseReply(read,'A restore database reply timed out. File copy and database import did not start.',timeout);
  try{
    const connection=await reply(()=>db.reserve(),recoveryConnectSeconds*1_000);
    // Cooperating restore processes cannot race for one target database.
    const [{locked}]=await reply(()=>connection`SELECT pg_try_advisory_lock(${portableMaintenanceLock}) AS locked`);
    if(!locked)throw new RecoveryFailure('A Harbor worker, migration or restore is using this database.');
    const state=await reply(()=>restoreDatabaseState(connection));
    if(state==='not_empty')throw new RecoveryFailure('Restore requires an empty Postgres database.');
    if(state==='missing_restore_permissions'){
      throw new RecoveryFailure('The restore login needs CREATE and TEMPORARY on the target database and USAGE and CREATE on its public schema.');
    }
    if(state!=='ok')throw new RecoveryFailure('Restore requires writable PostgreSQL 18 or newer with UTF-8 encoding.');
    if(!await objectBucketIsEmpty())throw new RecoveryFailure('Restore requires an empty S3 bucket.');
    // A unique lock proves psql reached this same server and database before it executes archive SQL.
    const targetProof=randomBytes(8).readBigInt64BE().toString();
    await reply(()=>connection`SELECT pg_advisory_lock(${targetProof}::bigint)`);
    return await restoreBundle(url,directory,dump,manifest,targetProof);
  }finally{
    // Closing this dedicated session releases both locks without another database reply.
    await close();
  }
}

async function restoreBundle(url:URL,directory:string,dump:string,manifest:Manifest,targetProof:string){
  const staging=await mkdtemp(join(tmpdir(),'harbor-restore-'));
  try{
    const decoded=join(staging,'restore.sql'),finalize=join(staging,'finalize.sql');
    await decodeRestoreArchive(dump,decoded);
    await writeFile(finalize,restoreFinalization(manifest),{mode:0o600,flag:'wx'});
    // Keep Postgres empty if copying any object fails. Only the disposable bucket may be partially written.
    for(const version of manifest.files){
      const bytes=await readVersion(directory,version);
      try{await writePrivateObject(version.key,bytes,version.sha256,{retryTransient:true});}
      catch{throw new RecoveryFailure('Could not verify a file in the restore bucket. Database import did not start.');}
    }
    const proof=`DO $harbor$ BEGIN
      IF pg_try_advisory_xact_lock('${targetProof}'::bigint) THEN
        RAISE EXCEPTION USING ERRCODE='HBR02', MESSAGE='Could not verify that both Postgres clients reached the same restore target.';
      END IF;
    END; $harbor$;`;
    const {stdout}=await pg('psql',url,['--no-psqlrc','--single-transaction','--set','ON_ERROR_STOP=1',
      '--set','VERBOSITY=verbose','--quiet','--tuples-only','--no-align','--command',proof,'--file',decoded,'--file',finalize]);
    const held=stdout.match(/^harbor_held=(\d+)$/m);
    if(!held)throw new RecoveryFailure(restoreUnconfirmed);
    return {versions:manifest.files.length,held:Number(held[1])};
  }finally{await rm(staging,{recursive:true,force:true});}
}

export async function runPortableRecovery(command:'backup'|'restore',url:URL,directory:string,mode:'local'|'hosted'='local'){
  process.umask(0o077);
  if(command==='restore')return restore(url,directory);
  if(mode==='hosted'){
    await privateBackupRoot(dirname(directory));
    if(!objectStorageConfigured())throw new RecoveryFailure('Configure private bucket access for hosted capture.');
  }
  return backup(url,directory);
}
