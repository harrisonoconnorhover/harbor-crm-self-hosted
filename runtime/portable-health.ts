import {outlookConfig} from './portable-outlook-provider';
import {fileURLToPath} from 'node:url';
import {enabledLeadForm} from '../db/postgres/lead-form-store';
import {leadFormEmbedOrigin} from '../lib/lead-form-embedding';
import {drizzle,type PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portableMigrationHistory,readPortableMigrations} from './portable-migrations.mjs';
import {googleLoginCallbackPath,googleLoginSetupIssues} from '../lib/identity';
import {oidcSettings,oidcCallbackPath} from './portable-company-oidc-config';
import {checkSamlMetadataFile} from './portable-saml-metadata-check';
import {samlCallbackPath,samlLoginSettings,samlMetadataPath} from './portable-saml-config';
import {oidcDirectoryAuthority,portableOidcDirectoryConfig,directoryAuthority,microsoftCallbackPath,microsoftLoginSettings,samlDirectoryAuthority,portableSamlDirectoryConfig,portableDirectoryConfig,portableLoginConfig,portableLoginProviders,portableRequestFailure} from './portable-login-config';
import {googleSigningKeysEndpoint,googleTokenEndpoint} from '../lib/google-identity';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableCalendarCancellationsEnabled,portableCalendarConfig,portableCalendarInvitesEnabled,
  portableCalendarReschedulesEnabled,verifyPortableCalendarConnection} from './portable-calendar-config';
import {CalendarError} from '../lib/calendar/google';
import {portableGmailInboxConfig} from './portable-gmail-inbox-config';
import {portableGmailAccessToken,portableGmailConfig,portableGmailOwner} from './portable-gmail-config';
import {portablePersonalGoogleCallbackPath,portablePersonalGoogleDeploymentReadiness} from './portable-google-config';
import {boundedGoogleRead} from './portable-google-connections';
import {GMAIL_READ_SCOPE,GMAIL_SCOPES,GmailError} from '../lib/email/gmail';
import {portableDatabaseUrl,portableMode,portableStorageEndpoint,portableWebAddress} from './portable-config.mjs';
import {env} from './portable-env';
import {assertObjectStorageAvailable,checkFilePrivacy,objectStorageConfigured} from './portable-object-storage';
import {boundedStatusTransaction,readPortableDatabaseTransaction,type StatusQuery} from './portable-database-status';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';

const migrations=readPortableMigrations(fileURLToPath(new URL('../../../db/postgres/migrations',import.meta.url)));
let client:ReturnType<typeof postgres>|undefined;
let frameDb:PostgresJsDatabase|undefined;
let releaseExpires=0,releaseReady=false,releaseCheck:Promise<boolean>|undefined;
let checkedAt=0,check:Promise<boolean>|undefined;
const releaseDeadlineMs=5000;
const readinessStates=new Map<'database'|'identity'|'storage',string>();

function observeReadiness(component:'database'|'identity'|'storage',status:string){
  if(process.env.HARBOR_PORTABLE_READINESS_LOGS!=='true')return;
  const previous=readinessStates.get(component);
  if(status===previous)return;
  readinessStates.set(component,status);
  if(status==='ok'&&previous===undefined)return;
  const event=JSON.stringify({event:'harbor_portable_readiness',component,status});
  if(status==='ok')console.log(event);
  else console.warn(event);
}

export function validateHostedWebStorage(){
  if(!objectStorageConfigured())throw Error('Configure private S3 storage for hosted Harbor.');
}

async function schemaState(db:StatusQuery){
  try{return (await portableMigrationHistory(db,migrations)).status;}
  catch{return 'unavailable';}
}

async function checkRelease(){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const url=portableDatabaseUrl(process.env,portableMode(process.env));
    const current=client??=postgres(url.href,{max:1,connect_timeout:3});
    // Postgres timeouts cannot bound a reply lost on an established socket.
    const deadline=new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>resolve('timeout'),releaseDeadlineMs);});
    const status=await Promise.race([boundedStatusTransaction(current,schemaState),deadline]);
    if(status==='timeout'){
      client=undefined;
      frameDb=undefined;
      void current.end({timeout:0}).catch(()=>{});
    }
    return status;
  }catch{return 'unavailable';}
  finally{clearTimeout(timer);}
}

export function portableReleaseReady(){
  if(releaseCheck)return releaseCheck;
  if(performance.now()<releaseExpires)return Promise.resolve(releaseReady);
  releaseCheck=checkRelease().then(status=>{
    observeReadiness('database',status);
    releaseReady=status==='ok';
    releaseExpires=performance.now()+1000;
    return releaseReady;
  }).finally(()=>{releaseCheck=undefined;});
  return releaseCheck;
}

async function checkDependencies(){
  try{portableLoginConfig(env);}
  catch{
    observeReadiness('identity','needs_setup');
    return false;
  }
  observeReadiness('identity','ok');
  if(objectStorageConfigured()){
    try{await assertObjectStorageAvailable();}
    catch{
      observeReadiness('storage','unavailable');
      return false;
    }
    observeReadiness('storage','ok');
  }
  return true;
}

export function portableIdentitySetupFailure(request:Request){
  const response=portableRequestFailure(request);
  return response?.status===503?response:null;
}

export async function portableFormFrameAncestor(id:string){
  if(!client)return undefined;
  try{
    const db=frameDb??=drizzle(client);
    const form=await db.transaction(async tx=>{
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      return enabledLeadForm(tx,id);
    });
    return leadFormEmbedOrigin(form?.definition.embedOrigin,portableMode(process.env));
  }catch{return undefined;}
}

export async function portableHealth(method:string,fingerprint:string){
  const now=Date.now();
  if(!check||now-checkedAt>=5000){
    checkedAt=now;
    check=checkDependencies();
  }
  const results=await Promise.all([portableReleaseReady(),check]);
  const ready=results.every(Boolean);
  return new Response(method==='HEAD'?null:ready?'ready':'unavailable',{
    status:ready?200:503,headers:{'cache-control':'no-store','content-type':'text/plain; charset=utf-8',
      'x-harbor-build-fingerprint':fingerprint},
  });
}

async function checkDatabase(mode:'local'|'hosted',profile:'web'|'worker',
  checks:{tasks:boolean;segments:boolean;gmail:boolean;workflowGmail:boolean;calendarInvites:boolean;calendarCancellations:boolean;calendarReschedules:boolean;personalGoogle:boolean;workspaceAccess:boolean;directoryGroups:boolean;samlGroups:boolean;oidcGroups:boolean}){
  let url:URL;
  try{url=portableDatabaseUrl(process.env,mode);}
  catch{return 'invalid_database_url';}
  try{
    return await readPortableDatabaseTransaction(url,async db=>{
      const status=await schemaState(db);
      if(status!=='ok')return status;
      const [{readOnly,canWrite,canCreateTasks,canScanSegments,canSaveGmail,canSaveCalendar,canUsePersonalGoogle,canManageWorkspaceAccess}]=await db<{
        readOnly:boolean;canWrite:boolean;canCreateTasks:boolean;canScanSegments:boolean;canSaveGmail:boolean;canSaveCalendar:boolean;
        canUsePersonalGoogle:boolean;canManageWorkspaceAccess:boolean
      }[]>`
        SELECT current_setting('transaction_read_only')='on' AS "readOnly",
          has_schema_privilege('public','USAGE') AND
          has_table_privilege('public.portable_workflow_path_steps','SELECT') AND
          has_table_privilege('public.portable_workflow_path_receipts','SELECT') AND
          has_table_privilege('public.portable_workflow_path_receipts','INSERT') AND
          CASE WHEN ${profile==='web'} THEN
            has_table_privilege('public.portable_workflow_path_steps','INSERT') AND
            has_table_privilege('public.contacts','UPDATE') AND
            has_table_privilege('public.login_sessions','DELETE') AND
            has_any_column_privilege('public.login_sessions','UPDATE') AND
            has_table_privilege('public.portable_login_attempt_uses','DELETE') AND
            -- Expired callback receipts are selected FOR UPDATE before cleanup.
            has_any_column_privilege('public.portable_login_attempt_uses','UPDATE') AND
            NOT EXISTS (
              SELECT FROM (VALUES
                ('public.portable_request_budgets','SELECT', ARRAY['scope','subject','minute','used']),
                ('public.portable_request_budgets','INSERT', ARRAY['scope','subject','minute','used']),
                ('public.portable_request_budgets','UPDATE', ARRAY['minute','used']),
                ('public.portable_login_attempt_uses','SELECT', ARRAY['state_hash','expires_minute']),
                ('public.portable_login_attempt_uses','INSERT', ARRAY['state_hash','expires_minute']),
                ('public.login_identities','SELECT', ARRAY['id','google_subject','microsoft_subject','oidc_subject','saml_subject','saml_directory_issuer','oidc_directory_issuer','directory_authority','email','full_name']),
                ('public.login_identities','INSERT', ARRAY['id','google_subject','microsoft_subject','oidc_subject','saml_subject','saml_directory_issuer','oidc_directory_issuer','directory_authority','email','full_name','created_at','updated_at']),
                ('public.login_identities','UPDATE', ARRAY['email','full_name','updated_at']),
                ('public.login_sessions','SELECT', ARRAY['token_hash','user_id','expires_at']),
                ('public.login_sessions','INSERT', ARRAY['token_hash','user_id','created_at','expires_at'])
              ) AS login_access(relation_name,permission,column_names)
              CROSS JOIN LATERAL unnest(login_access.column_names) AS required(column_name)
              WHERE NOT has_column_privilege(login_access.relation_name,required.column_name,login_access.permission)
            )
          ELSE
            has_table_privilege('public.portable_jobs','SELECT') AND
            has_table_privilege('public.portable_jobs','INSERT') AND
            has_table_privilege('public.portable_jobs','UPDATE') AND
            has_table_privilege('public.portable_job_attempts','INSERT') AND
            has_table_privilege('public.portable_job_attempts','UPDATE') AND
            has_table_privilege('public.portable_notes','INSERT') AND
            has_table_privilege('public.private_workspaces','SELECT') AND
            has_column_privilege('public.private_workspaces','last_job_claim_at','UPDATE') AND
            has_table_privilege('public.contacts','SELECT') AND
            has_any_column_privilege('public.contacts','UPDATE') AND
            -- A worker can finish an already-queued form or segment Note in Notes-only mode.
            has_table_privilege('public.portable_lead_form_note_sources','SELECT') AND
            has_table_privilege('public.portable_lead_forms','SELECT') AND
            has_table_privilege('public.portable_lead_form_activations','SELECT') AND
            has_table_privilege('public.portable_manual_workflow_run_actions','SELECT') AND
            has_column_privilege('public.portable_manual_workflow_run_actions','job_id','UPDATE') AND
            -- Completing even a Note can enqueue a Task or webhook for a capable worker.
            has_column_privilege('public.portable_workflow_path_steps','job_id','UPDATE') AND
            has_table_privilege('public.portable_task_jobs','INSERT') AND
            has_table_privilege('public.portable_workflow_webhook_jobs','INSERT') AND
            -- Verifying a webhook successor locks the workflow revision FOR SHARE.
            has_any_column_privilege('public.portable_deal_workflows','UPDATE') AND
            NOT EXISTS (
              SELECT FROM (VALUES
                ('public.portable_deal_workflows', ARRAY['workspace_id','id','revision']),
                ('public.portable_workflow_activations', ARRAY['workspace_id','workflow_id']),
                ('public.portable_job_attempts', ARRAY['workspace_id','job_id','number']),
                ('public.contact_events', ARRAY['workspace_id','contact_id','revision','previous','data']),
                ('public.portable_lead_inquiries', ARRAY['workspace_id','form_id','id','contact_id','status'])
              ) AS note_reads(relation_name,column_names)
              CROSS JOIN LATERAL unnest(note_reads.column_names) AS required(column_name)
              WHERE NOT has_column_privilege(note_reads.relation_name,required.column_name,'SELECT')
            ) AND
            has_table_privilege('public.portable_worker_heartbeat','SELECT') AND
            has_table_privilege('public.portable_worker_heartbeat','INSERT') AND
            has_table_privilege('public.portable_worker_heartbeat','UPDATE')
          END AS "canWrite",
          CASE WHEN ${checks.tasks} THEN
            has_table_privilege('public.portable_task_jobs','SELECT') AND
            has_table_privilege('public.portable_tasks','INSERT') AND
            has_table_privilege('public.portable_task_events','INSERT') AND
            has_column_privilege('public.login_identities','id','SELECT') AND
            has_column_privilege('public.login_identities','email','SELECT') AND
            has_column_privilege('public.login_identities','full_name','SELECT')
          ELSE true END AS "canCreateTasks",
          CASE WHEN ${checks.segments} THEN
            has_table_privilege('public.portable_segment_workflow_scans','SELECT') AND
            has_table_privilege('public.portable_segment_workflow_scans','UPDATE') AND
            has_table_privilege('public.portable_segment_workflow_members','SELECT') AND
            has_table_privilege('public.portable_segment_workflow_members','INSERT') AND
            has_table_privilege('public.portable_segment_workflow_members','UPDATE') AND
            has_table_privilege('public.portable_segment_workflow_members','DELETE') AND
            has_table_privilege('public.portable_workflow_runs','SELECT') AND
            has_table_privilege('public.portable_workflow_runs','INSERT') AND
            has_table_privilege('public.portable_manual_workflow_runs','SELECT') AND
            has_table_privilege('public.portable_workflow_activations','SELECT') AND
            has_table_privilege('public.portable_deal_workflows','SELECT') AND
            has_table_privilege('public.portable_segments','SELECT')
          ELSE true END AS "canScanSegments",
          CASE WHEN ${checks.gmail} THEN
            has_table_privilege('public.portable_scheduled_gmail','SELECT') AND
            has_table_privilege('public.portable_email_unsubscribe_tokens','INSERT') AND
            NOT EXISTS (
              SELECT FROM (VALUES
                ('public.portable_scheduled_gmail','UPDATE', ARRAY['dispatch_started_at','provider_id']),
                ('public.login_identities','SELECT', ARRAY['id','email']),
                ('public.portable_email_suppressions','SELECT', ARRAY['id','workspace_id','email'])
              ) AS gmail_access(relation_name,permission,column_names)
              CROSS JOIN LATERAL unnest(gmail_access.column_names) AS required(column_name)
              WHERE NOT has_column_privilege(gmail_access.relation_name,required.column_name,gmail_access.permission)
            ) AND (NOT ${checks.workflowGmail} OR (
              has_table_privilege('public.portable_workflow_runs','SELECT') AND
              has_table_privilege('public.portable_deal_workflows','SELECT') AND
              has_table_privilege('public.portable_workflow_activations','SELECT')
            ))
          ELSE true END AS "canSaveGmail",
          CASE WHEN ${checks.calendarInvites} THEN
            has_table_privilege('public.portable_calendar_meetings','SELECT') AND
            has_table_privilege('public.portable_calendar_meetings','INSERT') AND
            has_table_privilege('public.portable_calendar_reschedules','SELECT') AND
            (NOT ${checks.calendarReschedules} OR has_table_privilege('public.portable_calendar_reschedules','INSERT')) AND
            has_any_column_privilege('public.private_workspaces','UPDATE') AND
            NOT EXISTS (
              SELECT FROM (VALUES
                (true,'public.private_workspaces','SELECT', ARRAY['id','owner_id']),
                (true,'public.contacts','SELECT', ARRAY['workspace_id','id','data','archived_at']),
                (true,'public.portable_email_suppressions','SELECT', ARRAY['id','workspace_id','email']),
                (true,'public.portable_calendar_meetings','UPDATE', ARRAY['status','event_url']),
                (${checks.calendarCancellations},'public.portable_calendar_meetings','UPDATE', ARRAY['cancellation_started_at']),
                (${checks.calendarReschedules},'public.portable_calendar_meetings','UPDATE', ARRAY[
                  'start_at','end_at','reschedule_revision','rescheduled_time_zone'
                ]),
                (${checks.calendarReschedules},'public.portable_calendar_reschedules','UPDATE', ARRAY['status'])
              ) AS calendar_access(enabled,relation_name,permission,column_names)
              CROSS JOIN LATERAL unnest(calendar_access.column_names) AS required(column_name)
              WHERE calendar_access.enabled AND NOT has_column_privilege(calendar_access.relation_name,required.column_name,calendar_access.permission)
            )
          ELSE true END AS "canSaveCalendar",
          CASE WHEN ${checks.personalGoogle} THEN
            has_table_privilege('public.portable_google_attempts','DELETE') AND
            has_table_privilege('public.portable_google_grants','DELETE') AND
            NOT EXISTS (
              SELECT FROM (VALUES
                ('public.portable_google_attempts', ARRAY['user_id','provider','session_hash','state_hash','verifier','expires_at','claimed']),
                ('public.portable_google_grants', ARRAY['user_id','provider','id','email','refresh_token','needs_reconnect'])
              ) AS personal_access(relation_name,column_names)
              CROSS JOIN LATERAL unnest(personal_access.column_names) AS required(column_name)
              CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE')) AS operation(permission)
              WHERE NOT has_column_privilege(personal_access.relation_name,required.column_name,operation.permission)
            )
          ELSE true END AS "canUsePersonalGoogle",
          CASE WHEN ${checks.workspaceAccess} THEN
            has_table_privilege('public.portable_workspace_invites','DELETE') AND
            has_table_privilege('public.portable_workspace_viewers','DELETE') AND
            has_table_privilege('public.portable_directory_users','DELETE') AND
            has_table_privilege('public.portable_workspace_teams','DELETE') AND
            has_any_column_privilege('public.private_workspaces','UPDATE') AND
            NOT EXISTS (
              SELECT FROM (VALUES
                ('public.private_workspaces', ARRAY['SELECT'], ARRAY['id','owner_id']),
                -- Drizzle includes schema-managed DEFAULT columns in the INSERT column list.
                ('public.private_workspaces', ARRAY['INSERT'], ARRAY['id','owner_id','last_sales_sequence_at','last_job_claim_at','last_task_repeat_at','last_form_note_promotion_at','last_lead_routing_at']),
                ('public.portable_workspace_invites', ARRAY['SELECT','INSERT'], ARRAY['id','workspace_id','email','role','expires_at','view_scope','edit_scope']),
                ('public.portable_workspace_invites', ARRAY['UPDATE'], ARRAY['id','role']),
                ('public.portable_custom_properties', ARRAY['SELECT'], ARRAY['workspace_id','visible_team_id']),
                ('public.portable_standard_property_access', ARRAY['SELECT','INSERT'], ARRAY['workspace_id','kind','id','restricted','visible_team_id','revision']),
                ('public.portable_standard_property_access', ARRAY['UPDATE'], ARRAY['restricted','visible_team_id','revision']),
                ('public.portable_directory_groups', ARRAY['SELECT'], ARRAY['workspace_id','team_id']),
                ('public.portable_directory_group_members', ARRAY['SELECT'], ARRAY['workspace_id','user_id','group_id']),
                ('public.portable_directory_users', ARRAY['SELECT','INSERT'], ARRAY['id','workspace_id','user_id','saml_issuer','oidc_issuer','saml_external_id','display_name']),
                ('public.portable_workspace_teams', ARRAY['SELECT','INSERT'], ARRAY['workspace_id','id','name','name_key','parent_id','revision']),
                ('public.portable_workspace_teams', ARRAY['UPDATE'], ARRAY['name','name_key','parent_id','revision']),
                ('public.portable_workspace_viewers', ARRAY['SELECT','INSERT'], ARRAY[
                  'workspace_id','viewer_id','id','role','contact_files','scheduled_notes','contact_outreach','record_activities','backup_admin','team_id','view_scope','edit_scope'
                ]),
                ('public.portable_workspace_viewers', ARRAY['UPDATE'], ARRAY[
                  'id','role','contact_files','scheduled_notes','contact_outreach','record_activities','backup_admin','team_id','view_scope','edit_scope'
                ])
              ) AS workspace_access(relation_name,permissions,column_names)
              CROSS JOIN LATERAL unnest(workspace_access.permissions) AS required_permission(name)
              CROSS JOIN LATERAL unnest(workspace_access.column_names) AS required_column(name)
              WHERE NOT has_column_privilege(workspace_access.relation_name,required_column.name,required_permission.name)
            )
            AND (NOT ${checks.directoryGroups||checks.samlGroups||checks.oidcGroups} OR (
              has_table_privilege('public.portable_directory_groups','DELETE') AND
              has_table_privilege('public.portable_directory_group_members','DELETE') AND
              -- lockDirectory uses SELECT FOR SHARE on the scoped token while processing a request.
              has_any_column_privilege('public.portable_api_tokens','UPDATE') AND
              NOT EXISTS (
                SELECT FROM (VALUES
                  ('public.portable_directory_users', ARRAY['UPDATE'], ARRAY['display_name']),
                  ('public.portable_directory_groups', ARRAY['SELECT','INSERT'], ARRAY['workspace_id','team_id']),
                  ('public.portable_directory_groups', ARRAY['SELECT','UPDATE'], ARRAY['group_id','display_name']),
                  ('public.portable_directory_groups', ARRAY['SELECT','INSERT'], CASE WHEN ${checks.directoryGroups} THEN ARRAY['tenant','external_id'] END),
                  ('public.portable_directory_groups', ARRAY['SELECT','INSERT'], CASE WHEN ${checks.samlGroups} THEN ARRAY['saml_issuer'] END),
                  ('public.portable_directory_groups', ARRAY['SELECT','INSERT'], CASE WHEN ${checks.oidcGroups} THEN ARRAY['oidc_issuer'] END),
                  ('public.portable_directory_groups', ARRAY['SELECT','INSERT'], CASE WHEN ${checks.samlGroups||checks.oidcGroups} THEN ARRAY['saml_group_name'] END),
                  ('public.portable_directory_groups', ARRAY['SELECT','UPDATE'], CASE WHEN ${checks.samlGroups||checks.oidcGroups} THEN ARRAY['saml_external_id'] END),
                  ('public.portable_directory_group_members', ARRAY['INSERT'], ARRAY['workspace_id','user_id','group_id']),
                  ('public.portable_api_tokens', ARRAY['SELECT'], ARRAY['workspace_id','issuer_id','id','token_hash','expires_at','revoked_at','scopes'])
                ) AS directory_access(relation_name,permissions,column_names)
                CROSS JOIN LATERAL unnest(directory_access.permissions) AS operation(name)
                CROSS JOIN LATERAL unnest(directory_access.column_names) AS required(name)
                WHERE NOT has_column_privilege(directory_access.relation_name,required.name,operation.name)
              )
            ))
          ELSE true END AS "canManageWorkspaceAccess"`;
      if(readOnly)return 'database_read_only';
      if(!canWrite)return 'missing_runtime_permissions';
      if(!canCreateTasks)return 'missing_task_worker_permissions';
      if(!canScanSegments)return 'missing_segment_worker_permissions';
      if(!canSaveGmail)return 'missing_gmail_worker_permissions';
      if(!canSaveCalendar)return 'missing_calendar_write_permissions';
      if(!canUsePersonalGoogle)return 'missing_personal_google_permissions';
      return canManageWorkspaceAccess?'ok':'missing_workspace_access_permissions';
    });
  }catch{return 'unavailable';}
}

async function checkStorage(mode:'local'|'hosted'){
  if(!objectStorageConfigured()){
    const partial=process.env.HARBOR_S3_ENDPOINT||process.env.HARBOR_S3_BUCKET||
      process.env.HARBOR_S3_ACCESS_KEY_ID||process.env.HARBOR_S3_SECRET_ACCESS_KEY||process.env.HARBOR_S3_ADDRESSING!==undefined;
    return mode==='local'&&!partial?'optional_unconfigured':'missing_storage_settings';
  }
  try{portableStorageEndpoint(process.env,mode);}
  catch{return 'invalid_storage_endpoint';}
  try{await assertObjectStorageAvailable();return 'ok';}
  catch{return 'unavailable';}
}

async function googleReachability(){
  const options:RequestInit={method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(4000)};
  const token=async()=>{
    try{
      const response=await fetch(googleTokenEndpoint,options);
      void response.body?.cancel().catch(()=>{});
      // The endpoint accepts POST for exchanges. An unauthenticated GET only tests reachability.
      return [400,404,405].includes(response.status)?'ok':'unavailable';
    }catch{return 'unavailable';}
  };
  const keys=async()=>{
    try{
      const response=await fetch(googleSigningKeysEndpoint,options);
      if(response.status!==200){
        void response.body?.cancel().catch(()=>{});
        return 'unavailable';
      }
      const text=await readBoundedRequestText(response,32_768);
      if(text===null)return 'unavailable';
      const {keys}=JSON.parse(text);
      return Array.isArray(keys)&&keys.some(key=>key?.kty==='RSA'&&
        [key.kid,key.n,key.e].every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]+$/.test(value)))?'ok':'unavailable';
    }catch{return 'unavailable';}
  };
  const [googleTokenReachability,googleSigningKeys]=await Promise.all([token(),keys()]);
  return {googleTokenReachability,googleSigningKeys};
}

async function checkGmailConnection(config:Parameters<typeof portableGmailAccessToken>[0]|undefined,scopes:readonly string[]){
  if(!config)return 'not_configured';
  try{await portableGmailAccessToken(config,scopes);return 'ok';}
  catch(error){return error instanceof GmailError&&error.code==='reauth'?'reauthorization_required':'unavailable';}
}

async function checkCalendarConnection(config:ReturnType<typeof portableCalendarConfig>){
  if(!config)return 'not_configured';
  try{
    await verifyPortableCalendarConnection(config,boundedGoogleRead().fetcher);
    return 'ok';
  }catch(error){return error instanceof CalendarError&&error.code==='reauth'?'reauthorization_required':'unavailable';}
}

export async function portableDoctor(profile:'web'|'worker',
  {beforeGoogle=false,checkGoogle=false,checkGmail=false,checkInbox=false,checkCalendar=false,checkTasks=false,checkSegments=false,checkWorkspaceAccess=false,samlMetadataFile,privateFile,expectedWebOrigin}:
  {beforeGoogle?:boolean;checkGoogle?:boolean;checkGmail?:boolean;checkInbox?:boolean;checkCalendar?:boolean;checkTasks?:boolean;checkSegments?:boolean;checkWorkspaceAccess?:boolean;samlMetadataFile?:string;privateFile?:string;expectedWebOrigin?:string}={}){
  const checks:Record<string,string>={};
  let mode:'local'|'hosted';
  try{mode=portableMode(process.env);}
  catch{return {profile,result:'needs_setup',checks:{mode:'invalid_mode'}};}
  const web=profile==='web';
  let login:{allowedEmails:string[]}|undefined;
  let webOrigin:string|undefined;
  let oidcCallbackUrl:string|undefined,googleCallbackUrl:string|undefined,microsoftCallbackUrl:string|undefined,samlCallbackUrl:string|undefined,samlMetadataUrl:string|undefined;
  let metadataComparison:Awaited<ReturnType<typeof checkSamlMetadataFile>>|undefined;
  let samlSigningCertificates:{sha256:string;expiresAt:string}[]|undefined;
  let signInSettingsToCheck:string[]|undefined;
  if(web){
    try{
      const {origin}=portableWebAddress(process.env,mode);
      webOrigin=origin.origin;
      checks.webOrigin='ok';
      if(beforeGoogle)googleCallbackUrl=webOrigin+googleLoginCallbackPath;
    }
    catch{checks.webOrigin='invalid_origin_or_port';}
    const {missing,invalidCredentials,invalidAllowlist}=googleLoginSetupIssues(env);
    const providers=portableLoginProviders(),hasMicrosoft=microsoftLoginSettings.some(key=>!!env[key]);
    if(env.HARBOR_DIRECTORY_AUTHORITY_WORKSPACE_ID||env.HARBOR_DIRECTORY_EMAIL_DOMAIN){
      checks.microsoftDirectoryAuthority=directoryAuthority()&&portableDirectoryConfig()?'ok':'invalid_microsoft_directory_authority';
    }
    if(env.HARBOR_OIDC_DIRECTORY_AUTHORITY_WORKSPACE_ID||env.HARBOR_OIDC_DIRECTORY_EMAIL_DOMAIN){
      checks.oidcDirectoryAuthority=oidcDirectoryAuthority()&&portableOidcDirectoryConfig()?'ok':'invalid_oidc_directory_authority';
    }
    if(process.env.HARBOR_SAML_DIRECTORY_AUTHORITY_WORKSPACE_ID||process.env.HARBOR_SAML_DIRECTORY_EMAIL_DOMAIN){
      checks.samlDirectoryAuthority=samlDirectoryAuthority()&&portableSamlDirectoryConfig()?'ok':'invalid_saml_directory_authority';
    }
    const hasGoogle=!!(env.HARBOR_LOGIN_GOOGLE_CLIENT_ID||env.HARBOR_LOGIN_GOOGLE_CLIENT_SECRET);
    if(hasMicrosoft){
      checks.microsoftSignIn=providers.microsoft?'ok':'invalid_sign_in_settings';
      if(webOrigin)microsoftCallbackUrl=webOrigin+microsoftCallbackPath;
    }
    const hasOidc=oidcSettings.some(key=>!!env[key]);
    if(hasOidc){
      checks.oidcSignIn=providers.oidc?'ok':'invalid_sign_in_settings';
      if(webOrigin)oidcCallbackUrl=webOrigin+oidcCallbackPath;
    }
    const hasSaml=samlLoginSettings.some(key=>!!env[key]);
    if(hasSaml){
      checks.samlSignIn=providers.saml?'ok':'invalid_sign_in_settings';
      samlSigningCertificates=providers.saml?.certificates.map(cert=>({sha256:cert.fingerprint256,expiresAt:cert.validToDate.toISOString()}));
      if(webOrigin){
        samlCallbackUrl=webOrigin+samlCallbackPath;
        samlMetadataUrl=webOrigin+samlMetadataPath;
      }
    }
    if(samlMetadataFile!==undefined){
      metadataComparison=await checkSamlMetadataFile(samlMetadataFile,providers.saml);
      checks.samlMetadata=metadataComparison.status;
    }
    login=providers.google??providers.microsoft??providers.saml??providers.oidc;
    const awaitingGoogle=beforeGoogle&&!hasMicrosoft&&!hasSaml&&!hasOidc&&!invalidAllowlist&&
      missing.includes('HARBOR_LOGIN_GOOGLE_CLIENT_ID')&&missing.includes('HARBOR_LOGIN_GOOGLE_CLIENT_SECRET');
    if((hasMicrosoft||hasSaml||hasOidc)&&!hasGoogle){
      checks.googleSignIn='disabled';
      googleCallbackUrl=undefined;
    }else if(awaitingGoogle){
      checks.googleSignIn='pending_setup';
    }else if(providers.google){
      checks.googleSignIn='ok';
    }else{
      checks.googleSignIn='invalid_sign_in_settings';
      const settingsToCheck=[...missing,...invalidCredentials];
      if(invalidAllowlist)settingsToCheck.push('HARBOR_LOGIN_ALLOWED_EMAILS');
      if(settingsToCheck.length)signInSettingsToCheck=settingsToCheck;
    }
  }
  const outlookEnabled=web&&process.env.HARBOR_PORTABLE_OUTLOOK_ENABLED==='true';
  const outlook=outlookEnabled?outlookConfig('outlook-mail'):undefined;
  if(outlookEnabled)checks.personalOutlook=outlook?'ok':'invalid_outlook_settings';
  const personalGoogle=web?portablePersonalGoogleDeploymentReadiness():undefined;
  const personalGoogleCallbackUrls=personalGoogle&&webOrigin?{
    gmail:webOrigin+portablePersonalGoogleCallbackPath('gmail'),
    calendar:webOrigin+portablePersonalGoogleCallbackPath('calendar'),
  }:undefined;
  if(personalGoogle){
    checks.personalGmail=personalGoogle.gmail;
    checks.personalCalendar=personalGoogle.calendar;
    if(personalGoogle.gmail==='disabled'&&personalGoogle.calendar==='disabled'){
      checks.personalGoogle='missing_personal_google_clients';
    }
  }
  const gmailWorker=web?undefined:portableGmailConfig();
  if(process.env.HARBOR_PORTABLE_GMAIL_ENABLED==='true'){
    const owner=portableGmailOwner();
    checks.gmail=!owner?'invalid_gmail_owner':
      web?login?.allowedEmails.includes(owner)?'ok':'owner_not_allowed':
      gmailWorker?'ok':'invalid_worker_gmail_settings';
  }else{
    checks.gmail=process.env.HARBOR_PORTABLE_WORKFLOW_GMAIL_ENABLED==='true'?'scheduled_gmail_required':'disabled';
  }
  if(!web&&expectedWebOrigin!==undefined){
    const expected=URL.parse(expectedWebOrigin);
    const valid=expected?.origin===expectedWebOrigin&&(expected.protocol==='https:'||
      (mode==='local'&&expected.protocol==='http:'&&expected.hostname==='127.0.0.1'));
    checks.gmailUnsubscribeOrigin=!valid?'invalid_expected_web_origin':!gmailWorker?'not_configured':
      gmailWorker.origin===expected.origin?'ok':'gmail_unsubscribe_origin_mismatch';
  }
  const inbox=web?portableGmailInboxConfig():undefined;
  if(web&&(process.env.HARBOR_PORTABLE_INBOX_ENABLED==='true'||process.env.HARBOR_PORTABLE_HOSTED_INBOX_ENABLED==='true')){
    checks.inbox=mode==='hosted'&&process.env.HARBOR_PORTABLE_HOSTED_INBOX_ENABLED!=='true'?'disabled':
      !inbox?'invalid_inbox_settings':login?.allowedEmails.includes(inbox.owner)?'ok':'inbox_owner_not_allowed';
  }
  const calendar=web?portableCalendarConfig():undefined;
  if(web&&process.env.HARBOR_PORTABLE_CALENDAR_ENABLED==='true'){
    checks.calendar=!calendar?'invalid_calendar_settings':
      login?.allowedEmails.includes(calendar.owner)?'ok':'calendar_owner_not_allowed';
  }
  if(web){
    const invitations=portableCalendarInvitesEnabled();
    if(invitations)checks.calendarInvitations=checks.calendar==='ok'?'ok':'calendar_connection_required';
    if(portableCalendarCancellationsEnabled()){
      checks.calendarCancellations=checks.calendarInvitations==='ok'?'ok':'calendar_invitations_required';
    }
    if(portableCalendarReschedulesEnabled()){
      checks.calendarReschedules=checks.calendarInvitations==='ok'?'ok':'calendar_invitations_required';
    }
  }
  const storageStatus=web?checkStorage(mode):Promise.resolve('not_required');
  const databaseChecks={
    tasks:!web&&checkTasks,segments:!web&&checkSegments,
    gmail:!web&&checkGmail&&checks.gmail==='ok',
    workflowGmail:process.env.HARBOR_PORTABLE_WORKFLOW_GMAIL_ENABLED==='true',
    calendarInvites:web&&checkCalendar&&checks.calendarInvitations==='ok',
    calendarCancellations:checks.calendarCancellations==='ok',
    calendarReschedules:checks.calendarReschedules==='ok',
    personalGoogle:Boolean(outlook)||personalGoogle?.gmail==='ok'||personalGoogle?.calendar==='ok',
    workspaceAccess:web&&checkWorkspaceAccess,directoryGroups:web&&checkWorkspaceAccess&&Boolean(portableDirectoryConfig()),
    oidcGroups:web&&checkWorkspaceAccess&&Boolean(portableOidcDirectoryConfig()),
    samlGroups:web&&checkWorkspaceAccess&&Boolean(portableSamlDirectoryConfig()),
  };
  const [database,storage,google,filePrivacy,gmailConnection,inboxConnection,calendarConnection]=await Promise.all([
    checkDatabase(mode,profile,databaseChecks),storageStatus,web&&checkGoogle?googleReachability():undefined,
    web&&privateFile?storageStatus.then(result=>result==='ok'?checkFilePrivacy(privateFile):'storage_not_ready'):undefined,
    !web&&checkGmail&&(expectedWebOrigin===undefined||checks.gmailUnsubscribeOrigin==='ok')
      ?checkGmailConnection(gmailWorker,GMAIL_SCOPES):undefined,
    web&&checkInbox?checkGmailConnection(checks.inbox==='ok'?inbox:undefined,[GMAIL_READ_SCOPE]):undefined,
    web&&checkCalendar?checkCalendarConnection(checks.calendar==='ok'?calendar:undefined):undefined,
  ]);
  checks.database=database;
  checks.storage=storage;
  if(filePrivacy)checks.filePrivacy=filePrivacy;
  if(gmailConnection)checks.gmailConnection=gmailConnection;
  if(inboxConnection)checks.inboxConnection=inboxConnection;
  if(calendarConnection)checks.calendarConnection=calendarConnection;
  Object.assign(checks,google);
  const passed=['ok','optional_unconfigured','not_required','disabled','pending_setup'];
  const ready=Object.values(checks).every(value=>passed.includes(value));
  const result=!ready?'needs_setup':checks.googleSignIn==='pending_setup'?'ready_for_google_setup':'ready';
  return {profile,mode,result,
    ...(web?{}:{workerEnabled:mode==='local'||process.env.HARBOR_PORTABLE_WORKER_ENABLED==='true'}),
    ...(oidcCallbackUrl?{oidcCallbackUrl}:{}),...(googleCallbackUrl?{googleCallbackUrl}:{}),...(microsoftCallbackUrl?{microsoftCallbackUrl}:{}),...(personalGoogleCallbackUrls?{personalGoogleCallbackUrls}:{}),
    ...(metadataComparison?{samlMetadataComparison:metadataComparison}:{}),...(samlCallbackUrl?{samlCallbackUrl,samlMetadataUrl}:{}),...(samlSigningCertificates?{samlSigningCertificates}:{}),...(signInSettingsToCheck?{signInSettingsToCheck}:{}),checks};
}
