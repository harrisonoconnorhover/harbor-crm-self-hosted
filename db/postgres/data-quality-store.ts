import {sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {portablePropertyGroupFields,type PortableCustomPropertyKind} from '../../lib/portable-custom-properties';
import {contacts} from './contact-schema';
import {companies} from './company-schema';
import {deals} from './deal-schema';
import {readOwnedWorkspaceId} from './private-workspace-store';

type Db=PostgresJsDatabase;
const recordKinds=['contacts','companies','deals'] as const;
const tables={contacts,companies,deals};

async function checkProperties(db:Db,workspace:string){
  // Expand only values actually stored on active records. Definitions without a
  // corresponding value survive the LEFT JOIN; false and zero are real values.
  const sources=recordKinds.map(kind=>sql`SELECT ${kind}::text AS kind, id, data->'custom' AS fields
    FROM ${tables[kind]} WHERE workspace_id=${workspace} AND archived_at IS NULL AND data ? 'custom'`);
  const fields=await db.execute<{kind:PortableCustomPropertyKind;id:string;label:string;populated:number;malformedId:string|null;referenced:boolean}>(sql`
    WITH records AS (${sql.join(sources,sql` UNION ALL `)}),
    checked AS (
      SELECT records.kind,records.id,f.key,CASE p.type
        WHEN 'number' THEN jsonb_typeof(f.value)<>'number'
        WHEN 'checkbox' THEN jsonb_typeof(f.value)<>'boolean'
        WHEN 'url' THEN jsonb_typeof(f.value)<>'string' OR length(f.value #>> '{}')>2048
          OR f.value #>> '{}' !~* '^https?://[^[:space:]/@?#]+([/?#][^[:space:]]*)?$'
          OR strpos(f.value #>> '{}',chr(92))>0 OR f.value #>> '{}' ~ '[[:cntrl:]]'
        WHEN 'email' THEN f.value #>> '{}' !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
        WHEN 'date' THEN f.value #>> '{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          OR NOT pg_input_is_valid(f.value #>> '{}','date')
        WHEN 'datetime' THEN f.value #>> '{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
          OR NOT pg_input_is_valid(left(f.value #>> '{}',10),'date')
        WHEN 'select' THEN NOT (p.options ? (f.value #>> '{}'))
        WHEN 'multiselect' THEN jsonb_typeof(f.value)<>'array' OR NOT (p.options @> f.value)
        ELSE jsonb_typeof(f.value)<>'string' END AS malformed
      FROM records
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(fields)='object' THEN fields ELSE '{}'::jsonb END) f
      JOIN portable_custom_properties p ON p.workspace_id=${workspace} AND p.kind=records.kind AND p.id::text=f.key
      WHERE f.value NOT IN ('null'::jsonb,'[]'::jsonb) AND
        (jsonb_typeof(f.value)<>'string' OR (f.value #>> '{}') ~ '[^[:space:]]')
    ), populated AS (
      SELECT kind,key,count(*)::int AS n,min(id::text) FILTER (WHERE malformed) AS malformed_id
      FROM checked GROUP BY kind,key
    )
    SELECT p.kind,p.id,p.label,coalesce(v.n,0) AS populated,v.malformed_id AS "malformedId",
      EXISTS (SELECT 1 FROM portable_saved_views s WHERE s.workspace_id=p.workspace_id AND s.kind=p.kind
        AND s.columns ? ('custom:'||p.id::text)) OR
      EXISTS (SELECT 1 FROM portable_reports r WHERE r.workspace_id=p.workspace_id AND r.definition->>'kind'=p.kind
        AND r.definition #>> '{customFilter,propertyId}'=p.id::text) OR
      (p.kind='deals' AND EXISTS (SELECT 1 FROM deal_pipeline_stages s WHERE s.workspace_id=p.workspace_id
        AND s.required_properties @> jsonb_build_array(jsonb_build_object('field','custom:'||p.id::text)))) AS referenced
    FROM portable_custom_properties p LEFT JOIN populated v ON v.kind=p.kind AND v.key=p.id::text
    WHERE p.workspace_id=${workspace} ORDER BY p.kind,p.label,p.id`);
  // A label can collide with a standard field, or differ only in spacing or punctuation.
  const normalize=(label:string)=>label.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
  const names=new Map<string,number>();
  for(const kind of recordKinds){
    for(const field of portablePropertyGroupFields(kind,[]))names.set(kind+':'+normalize(field.label),1);
  }
  for(const property of fields){
    const key=property.kind+':'+normalize(property.label);
    names.set(key,(names.get(key)??0)+1);
  }
  return fields.map(p=>({kind:p.kind,id:p.id,label:p.label,noData:p.populated===0,unused:p.populated===0&&!p.referenced,
    malformedId:p.malformedId,duplicate:names.get(p.kind+':'+normalize(p.label))!>1,format:!!p.malformedId||p.label!==p.label.trim()||/\s{2,}|[\t\r\n]/.test(p.label)}));
}

async function checkRecords(db:Db,workspace:string,kind:'contacts'|'companies'){
  const format=kind==='contacts'?sql`nullif(data->>'email','') IS NOT NULL AND
    data->>'email' !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'`:
    sql`(nullif(data->>'domain','') IS NOT NULL AND data->>'domain' ~ '[[:space:]/@?#]')
      OR (nullif(data->>'website','') IS NOT NULL AND data->>'website' !~* '^https?://[^[:space:]/@?#]+([/?#][^[:space:]]*)?$')`;
  const [row]=await db.execute<{missing:number;format:number;missingId:string|null;formatId:string|null}>(sql`
    SELECT count(*) FILTER (WHERE missing)::int AS missing,count(*) FILTER (WHERE formatting)::int AS format,
      min(id::text) FILTER (WHERE missing) AS "missingId",min(id::text) FILTER (WHERE formatting) AS "formatId"
    FROM (SELECT id,coalesce(data->>'name','') !~ '[^[:space:]]' AS missing,
      (coalesce(data->>'name','') ~ '^[[:space:]]|[[:space:]]$' OR (${format})) AS formatting
      FROM ${tables[kind]} WHERE workspace_id=${workspace} AND archived_at IS NULL) checked`);
  return {kind,...row};
}

async function checkDealStageRequirements(db:Db,workspace:string){
  // Owners may tighten a stage after deals have entered it. Count each affected
  // deal once, following the record editor's definition of a missing value.
  const [row]=await db.execute<{count:number;firstId:string|null}>(sql`
    SELECT count(*)::int AS count,min(d.id::text) AS "firstId"
    FROM deal_pipeline_stages s
    JOIN deals d ON d.workspace_id=s.workspace_id AND d.pipeline_id=s.pipeline_id AND d.stage_id=s.id
    WHERE s.workspace_id=${workspace} AND s.required_properties<>'[]'::jsonb AND d.archived_at IS NULL
      AND EXISTS (
        SELECT 1 FROM jsonb_to_recordset(s.required_properties) AS rule(field text,required boolean)
        CROSS JOIN LATERAL (SELECT CASE WHEN rule.field LIKE 'custom:%'
          THEN d.data->'custom'->substr(rule.field,8) ELSE d.data->rule.field END AS value) v
        WHERE rule.required AND (v.value IS NULL OR v.value IN ('null'::jsonb,'[]'::jsonb)
          OR (jsonb_typeof(v.value)='string' AND v.value #>> '{}' !~ '[^[:space:]]'))
      )`);
  return row;
}

async function checkIntegrations(db:Db,workspace:string){
  const [row]=await db.execute<{audience:string;salesforceDeliveries:number;webhookDeliveries:number}>(sql`
    SELECT coalesce((SELECT CASE
      WHEN state='ready' AND started_at<=statement_timestamp()-interval '24 hours' THEN 'stale'
      WHEN state='syncing' AND progressed_at<statement_timestamp()-interval '5 minutes' THEN 'stalled'
      ELSE state END FROM portable_marketing_audience_sync WHERE workspace_id=${workspace}), 'missing') AS audience,
      (SELECT count(*)::int FROM portable_marketing_form_deliveries WHERE workspace_id=${workspace}
        AND kind='salesforce' AND state IN ('failed','uncertain')) AS "salesforceDeliveries",
      (SELECT count(*)::int FROM portable_webhook_deliveries WHERE workspace_id=${workspace}
        AND status IN ('failed','uncertain')) AS "webhookDeliveries"`);
  return row;
}

async function checkWorkflows(db:Db,workspace:string){
  const [row]=await db.execute<{unused:number;issues:number}>(sql`
    WITH runs AS (
      SELECT workflow_id,job_id,issue IN ('queue_full','gmail_unavailable') AND operator_reviewed_at IS NULL AS missed
      FROM portable_workflow_runs WHERE workspace_id=${workspace}
      UNION ALL SELECT workflow_id,id,false FROM portable_manual_workflow_runs WHERE workspace_id=${workspace}
      UNION ALL SELECT workflow_id,job_id,false FROM portable_workflow_path_steps WHERE workspace_id=${workspace}
      UNION ALL SELECT m.workflow_id,a.job_id,false FROM portable_manual_workflow_run_actions a
        JOIN portable_manual_workflow_runs m ON m.workspace_id=a.workspace_id AND m.id=a.run_id WHERE a.workspace_id=${workspace}
    ), history AS (
      SELECT r.workflow_id,bool_or(r.missed OR (j.status IN ('failed','attention') AND j.operator_reviewed_at IS NULL)) AS needs_review
      FROM runs r LEFT JOIN portable_jobs j ON j.workspace_id=${workspace} AND j.id=r.job_id GROUP BY r.workflow_id
    )
    SELECT count(*) FILTER (WHERE h.workflow_id IS NULL)::int AS unused,count(*) FILTER (WHERE h.needs_review)::int AS issues
      FROM portable_deal_workflows w LEFT JOIN history h ON h.workflow_id=w.id WHERE w.workspace_id=${workspace}`);
  return row;
}

export async function readOwnerDataQuality(db:Db,ownerId:string){
  const workspace=await readOwnedWorkspaceId(db,ownerId);
  if(!workspace)return;
  const [properties,contactRecords,companyRecords,stageRequirements,integrations,workflows]=await Promise.all([
    checkProperties(db,workspace),checkRecords(db,workspace,'contacts'),checkRecords(db,workspace,'companies'),
    checkDealStageRequirements(db,workspace),checkIntegrations(db,workspace),checkWorkflows(db,workspace),
  ]);
  return {properties,records:[contactRecords,companyRecords],stageRequirements,integrations,workflows};
}
