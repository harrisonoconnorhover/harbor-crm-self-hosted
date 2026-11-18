import {importRowMatches} from './import-matching';
import {leadPipelines,leadStageOptions} from './lead-pipelines';
import {defaultPipelineId} from './pipeline-default';
import {uniqueNumber} from './unique-number';
import {uniqueProperties,uniqueValueKey} from './property-unique';
import {isTextProperty} from "./property-text";
import {HISTORY_VALUE_MARKER,decodeHistoryValue,historyColumnLabel} from './history-export-values';
import { ticketCatalog, ticketPipelineFor } from "./ticket-pipelines";
import { samePropertyValue } from "./property-values";
import { associationImportFieldCatalog, planImportAssociations, type ImportAssociation } from "./import-associations";
import type { Association } from "./associations";
import { standardFields, standardField } from "./standard-properties";
import {
  type DealStageSource,
  recordStages,
  stageLabel,
  pipelineList,
  isPipelineSettings,
} from "./forecast";
import {
  type Data,
  type Kind,
  type CRMRecord,
  lifecycles, leadStages,
  stages,
} from "./crm";
import { parseRecord, type Property } from "./workspace";
import {linkTextSchema,propertyURLSchema} from './property-links';
import {propertyValue} from './record-properties';
import {canProtectImportField,importFieldPopulated} from './import-protection';
export const MAX_IMPORT_ROWS = 500;
export type ImportMode = "create" | "update" | "upsert";
export const ownerMemberImportField = {id:"ownerMember",label:"Record owner (workspace member)"};
export type ImportRow = { preservedFields?: string[]; ownerAssignment?: {id:string;workspaceId:string;name:string;email:string}|null; row: number; associations?: ImportAssociation[]; data?: Data; target?: CRMRecord; changes?: { field: string; before: unknown; after: unknown }[]; skipped?: string; error?: string };
export function importCounts(rows: ImportRow[]) {
  const counts = {created: 0, updated: 0, skipped: 0, errors: 0, ready: 0};
  for (const row of rows) {
    if (row.error) counts.errors++;
    else if (row.target && (row.data || row.associations?.some(a => a.changed))) counts.updated++;
    else if (!row.target && row.data) counts.created++;
    else counts.skipped++;
  }
  counts.ready = counts.created + counts.updated;
  return counts;
}
export function importReview(plan: ImportRow[]) {
  return JSON.stringify(plan.map(r => ({ row: r.row, data: r.data, ownerAssignment:r.ownerAssignment, ...(r.preservedFields?.length?{preservedFields:r.preservedFields}:{}), associations:r.associations, skipped: r.skipped, error: r.error,
    target: r.target ? { id: r.target.id, data: r.target.data, updatedAt: r.target.updatedAt } : undefined })));
}
export const importFields: Record<Kind, string[]> = {
  leads: ["name","leadPipelineId","leadStage","owner","companyId","contactId"],
  contacts: ["name", "email", "phone", "title", "lifecycle", "owner"],
  companies: ["name", "domain", "website", "industry", "city", "lifecycle", "owner"],
  deals: ["name", "amount", "pipelineId", "stage", "closeDate", "owner"],
  tickets: ["name", "ticketPipelineId", "ticketStatus", "ticketPriority", "owner"],
  tasks: ["name", "dueDate", "dueTime", "dueTimeZone", "dueTimeOccurrence", "priority", "status", "owner", "taskType"],
};
for (const kind of Object.keys(importFields) as Kind[]) importFields[kind].push(...standardFields(kind).map(f => f.id));
// RFC-style quoted cells, including embedded commas, quotes and line breaks.
export function parseCSV(text: string, limits = {maxRows: MAX_IMPORT_ROWS, maxBytes: 2_000_000}): {
  headers: string[];
  rows: string[][];
  historyColumns?: number[];
} {
  if (new TextEncoder().encode(text).byteLength > limits.maxBytes)
    throw new Error(`Choose a CSV smaller than ${limits.maxBytes / 1_000_000} MB.`);
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
    closed = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim())) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else cell += c;
    } else if (c === ",") endCell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else if (c === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || c === '"')
        throw new Error(
          "Invalid CSV quoting. Export as comma-separated CSV and try again.",
        );
      cell += c;
    }
    if (rows.length > limits.maxRows + 1)
      throw new Error(`Import up to ${limits.maxRows} records at a time.`);
  }
  if (quoted) throw new Error("A quoted CSV cell is not closed.");
  if (cell || row.length || closed) endRow();
  const headers = rows.shift()?.map((s) => s.trim()) ?? [];
  if (!headers.length || !rows.length)
    throw new Error("Include a header row and at least one record.");
  if(headers.length>100&&headers.some(h=>h.endsWith(HISTORY_VALUE_MARKER)))throw Error("Keep Record ID and only the history value column you want before importing. Use at most 100 columns.");
  if (headers.length > 100 || rows.length > limits.maxRows)
    throw new Error(`Use at most 100 columns and ${limits.maxRows} records.`);
  if (rows.some((r) => r.length !== headers.length))
    throw new Error(
      "Some rows have a different number of cells than the header.",
    );
  const historyColumns=headers.flatMap((h,i)=>h.endsWith(HISTORY_VALUE_MARKER)?[i]:[]);
  return { headers, rows, ...(historyColumns.length?{historyColumns}:{}) };
}
const normalized = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
export function captionImportFields(kind:Kind,properties:Property[]) {
  return properties.filter(p=>p.kind===kind&&!p.standardField&&!p.archivedAt&&p.type==='url'&&p.allowCustomLinkText)
    .map(p=>({id:`linkText:${p.id}`,label:`${p.label} link text`}));
}
export function autoMap(headers: string[], kind: Kind, properties: Property[]) {
  const objectName={contacts:'contact',companies:'company',deals:'deal',tasks:'task',tickets:'ticket',leads:'lead'}[kind];
  const fields = [
    { id: "recordId", label: "Record ID" },
    ownerMemberImportField,
    ...captionImportFields(kind,properties),
    ...associationImportFieldCatalog(properties),
    ...importFields[kind].map((id) => ({ id, label: standardField(kind, id)?.label ?? id })),
    ...properties
      .filter((p) => !p.standardField && p.kind === kind)
      .map((p) => ({ id: `custom:${p.id}`, label: p.label })),
  ];
  const used = new Set<string>();
  return headers.map((h) => {
    const aliases: Record<string, string> = {
      associatedcompanydomain: "association:companies:domain",
      associatedcontactemail: "association:contacts:email",
      associatedcompanyrecordid: "association:companies:id",
      associatedcontactrecordid: "association:contacts:id",
      associateddealrecordid: "association:deals:id",
      associatedtaskrecordid: "association:tasks:id",
      recordid: "recordId",
      id: "recordId",
      fullname: "name",
      companyname: "name",
      companydomain: "domain",
      websiteurl: "website",
      companywebsite: "website",
      dealname: "name",
      tasktitle: "name",
      jobtitle: "title",
      emailaddress: "email",
      phonenumber: "phone",
      lifecyclestage: "lifecycle",
      dealstage: "stage",
      pipeline: kind === "leads" ? "leadPipelineId" : kind === "tickets" ? "ticketPipelineId" : "pipelineId",
      ticketname: "name",
      ticketpipeline: "ticketPipelineId",
      status: kind === "tickets" ? "ticketStatus" : "status",
      priority: kind === "tickets" ? "ticketPriority" : "priority",
      dealpipeline: "pipelineId",
      recordowner: "owner",
      [objectName+'owner']: "owner",
      [objectName+'name']: "name",
      owneremail:"ownerMember",
      ownermemberid:"ownerMember",
      ownermember:"ownerMember",
      annualrevenue: "annualRevenue",
      streetaddress: "address",
      streetaddress2: "address2",
      employees: "numberOfEmployees",
      zipcode: "postalCode",
    };
    const key = normalized(historyColumnLabel(h));
    if(h.endsWith(HISTORY_VALUE_MARKER)&&headers.filter(other=>other.endsWith(HISTORY_VALUE_MARKER)&&normalized(historyColumnLabel(other))===key).length>1)return "";
    const matches = fields.filter(
      (f) => normalized(f.label) === key || normalized(f.id) === key || f.id === aliases[key],
    );
    const match=matches.length===1?matches[0]:undefined;
    if (!match || used.has(match.id)) return "";
    used.add(match.id);
    return match.id;
  });
}
function convert(value: string, type: string) {
  if (type === "textarea") return value.trim() ? value : undefined;
  value = value.trim();
  if (!value) return undefined;
  if (type === "number") {
    const n = Number(value);
    if (
      !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
      !Number.isFinite(n)
    )
      throw new Error("Use a plain number without currency symbols.");
    return n;
  }
  if (type === "checkbox") {
    if (/^(true|yes|1)$/i.test(value)) return true;
    if (/^(false|no|0)$/i.test(value)) return false;
    throw new Error("Use yes/no or true/false for checkboxes.");
  }
  return value;
}
export function planImport(
  rows: string[][],
  mapping: string[],
  kind: Kind,
  properties: Property[],
  existing: CRMRecord[],
  dealStages: DealStageSource = stages,
  defaultPipeline = defaultPipelineId(kind,dealStages),
  mode: ImportMode = "create",
  associations: Association[] = [],
  historyColumns: number[] = [],
  matchProperty?: string,
  doNotOverwrite: string[] = [],
  previouslyPopulated: (recordId:string,field:string)=>boolean = ()=>false,
) {
  if(historyColumns.some(i=>!Number.isInteger(i)||i<0||i>=mapping.length))throw Error('Invalid history value columns.');
  if(historyColumns.some(i=>mapping[i]==='ownerMember'))throw Error('Restore owner text with the stored-text mapping; member assignment needs an ordinary member email, ID or name column.');
  if(historyColumns.some(i=>mapping[i]?.startsWith('linkText:')))throw Error('Link captions cannot be restored from history-only columns. Import ordinary caption text after reviewing its destination URL.');
  if(historyColumns.length&&mode!=='update')throw Error('Use Update existing records when restoring history values.');
  if(historyColumns.length&&!historyColumns.some(i=>mapping[i]&&mapping[i]!=='recordId'&&!mapping[i].startsWith('association:')))throw Error('Choose one history value column to restore.');
  const used = mapping.filter(Boolean);
  if(new Set(doNotOverwrite).size!==doNotOverwrite.length||doNotOverwrite.some(f=>!used.includes(f)||!canProtectImportField(f)))throw Error("Choose mapped properties for Don’t overwrite; IDs, associations and link-text columns cannot use it.");
  if(doNotOverwrite.length&&historyColumns.length)throw Error("Don’t overwrite cannot be combined with history-value restoration.");
  if(used.includes("owner")&&used.includes("ownerMember"))throw Error("Map either stored owner text or a workspace member, not both.");
  if (mode === "create" && !used.includes("name") && !((kind === "contacts" && ["firstName", "lastName", "email"].some(key => used.includes(key))) || (kind === "companies" && used.includes("domain"))))
    throw new Error(kind === "contacts" ? "Map Name, First name, Last name or Email for new contacts." : kind === "companies" ? "Map Name or Company domain for new companies." : "Map a column to name.");
  if (new Set(used).size !== used.length)
    throw new Error("Map each property only once.");
  const allowed = [
    "recordId", "ownerMember",
    ...captionImportFields(kind,properties).map(f=>f.id),
    ...associationImportFieldCatalog(properties).map(f=>f.id),
    ...importFields[kind],
    ...properties.filter((p) => !p.standardField && p.kind === kind).map((p) => `custom:${p.id}`),
  ];
  if (used.some((k) => !allowed.includes(k)))
    throw new Error("A mapped property is no longer available.");
  if (!rows.length || rows.length > MAX_IMPORT_ROWS)
    throw new Error(`Import between 1 and ${MAX_IMPORT_ROWS} records.`);
  const uniqueDefs=uniqueProperties(properties).filter(p=>p.kind===kind);
  const identifier=matchProperty?uniqueDefs.find(p=>p.id===matchProperty&&!p.archivedAt):undefined;
  if(matchProperty&&(!identifier||!used.includes("custom:"+matchProperty)))throw Error("Map the selected unique property to identify records.");
  const claims=new Map(uniqueDefs.map(p=>[p.id,new Map(existing.filter(r=>r.kind===kind).flatMap(r=>{const key=uniqueValueKey(r.data.custom?.[p.id]);return key===null?[]:[[key,r.id] as const];}))]));
  const uniqueKey = identifier ? null :
    kind === "contacts" ? "email" : kind === "companies" ? "domain" : null;
  const seen = new Set(
    existing
      .filter((r) => r.kind === kind)
      .map((r) =>
        uniqueKey
          ? String(r.data[uniqueKey] ?? "")
              .trim()
              .toLowerCase()
          : "",
      )
      .filter(Boolean),
  );
  const owned = existing.filter(r => r.kind === kind);
  if (mode !== "create" && !used.includes("recordId") && !identifier && !(uniqueKey && used.includes(uniqueKey)))
    throw new Error(`Map Record ID${uniqueKey ? ` or ${uniqueKey}` : ""} or a custom unique property to identify existing records.`);
  const result: ImportRow[] = [], updatedIds = new Set<string>();
  for (const [i, cells] of rows.entries()) {
    try {
      if (cells.length !== mapping.length)
        throw new Error("Column count does not match.");
      const {recordId,matches}=importRowMatches(cells,mapping,kind,owned,identifier,historyColumns);
      if (recordId && !matches.length) throw new Error("Record ID does not match an available record of this type.");
      if (matches.length && mode === "create") { result.push({ row: i + 2, skipped: "Existing record (create-only import)" }); continue; }
      if (matches.length > 1) throw new Error(`Multiple records share this ${uniqueKey}. Use Record ID to choose one.`);
      const target = matches[0];
      if (!target && mode === "update") { result.push({ row: i + 2, skipped: "No matching record (update-only import)" }); continue; }
      if (target && updatedIds.has(target.id)) throw new Error("This record appears more than once. Keep one row per record.");
      if (target) updatedIds.add(target.id);
      const preservedFields=target?doNotOverwrite.filter(field=>importFieldPopulated(target.data,field,kind)||previouslyPopulated(target.id,field)):[];
      const raw: Record<string, unknown> = {},
        custom: Record<string, unknown> = {};
      mapping.forEach((key, j) => {
        if (preservedFields.includes(key)) return;
        if (!key || key === "recordId" || key === "ownerMember" || key.startsWith("association:") || key.startsWith('linkText:')) return;
        const p = properties.find((p) => !p.standardField && `custom:${p.id}` === key);
        const type=p?.type ?? standardField(kind,key,properties)?.type ?? (key==='amount'?'number':'text');
        const decoded=historyColumns.includes(j)?decodeHistoryValue(cells[j]):cells[j];
        if(decoded===undefined)return;
        if(decoded===null){if(p)custom[p.id]=null;else raw[key]=undefined;return;}
        const historical=historyColumns.includes(j);
        const value=p?.uniqueValues&&p.type==='number'&&decoded!==''?uniqueNumber(decoded):historical ? type==='multiselect'?JSON.parse(decoded):type==='number'||type==='checkbox'?convert(decoded,type):decoded : convert(decoded,p && isTextProperty(p.type) ? "textarea" : type);
        if(historyColumns.includes(j)&&type==='multiselect'&&(!Array.isArray(value)||value.some(v=>typeof v!=='string')))throw Error('History multiselect values must be an array of choices.');
        if (value === undefined) return;
        if (p)
          custom[p.id] =
            p.type === "select" && !historical
              ? (p.options.find(
                  (o) => o.toLowerCase() === String(value).toLowerCase(),
                ) ?? value)
              : value;
        else {
          const enums: Record<string, readonly string[]> = {
            lifecycle: lifecycles,
            leadStage: leadStageOptions(dealStages),

            priority: ["Low", "Medium", "High"],
            status: ["Not started", "Completed"],
          };
          raw[key] = historical ? value :
            (standardField(kind, key, properties)?.options ?? enums[key])?.find(
              (o) => o.toLowerCase() === String(value).toLowerCase(),
            ) ?? value;
        }
      });
      // CSVs commonly have separate name parts or email only. Derive a display
      // name only for new contacts; blank cells must not rename an existing one.
      if (kind === "contacts" && !target && !raw.name) {
        raw.name = [raw.firstName, raw.lastName].filter(value => typeof value === "string" && value).join(" ") || raw.email;
      }
      if (kind === "companies" && !target && !raw.name) raw.name=raw.domain;
      if (kind === "deals") {
        if (!raw.pipelineId) raw.pipelineId = target ? target.data.pipelineId || "default" : defaultPipeline;
        const pipelines = isPipelineSettings(dealStages)
          ? pipelineList(dealStages)
          : [{ id: "default", name: "Sales pipeline" }];
        if (raw.pipelineId)
          raw.pipelineId =
            pipelines.find(
              (p) =>
                p.id === raw.pipelineId ||
                p.name.toLowerCase() === String(raw.pipelineId).toLowerCase(),
            )?.id ?? raw.pipelineId;
        const options = recordStages(
          dealStages,
          String(raw.pipelineId || "default"),
        );
        if (raw.stage)
          raw.stage =
            options.find(
              (s) =>
                stageLabel(
                  dealStages,
                  s,
                  String(raw.pipelineId),
                ).toLowerCase() === String(raw.stage).toLowerCase(),
            ) ??
            options.find(
              (s) => s.toLowerCase() === String(raw.stage).toLowerCase(),
            ) ??
            raw.stage;
      }
      if(kind==='leads'){
        const supplied=String(raw.leadPipelineId||(target?target.data.leadPipelineId||'default':defaultPipeline));
        const pipeline=leadPipelines(dealStages).find(p=>p.id===supplied||p.name.toLowerCase()===supplied.toLowerCase());
        if(!pipeline)throw Error('Choose an available lead pipeline.');raw.leadPipelineId=pipeline.id;
        if(raw.leadStage)raw.leadStage=pipeline.stages.find(s=>s.id===raw.leadStage||s.label.toLowerCase()===String(raw.leadStage).toLowerCase())?.id??raw.leadStage;
        else if(target&&(target.data.leadPipelineId||'default')!==pipeline.id)raw.leadStage=pipeline.stages[0].id;
      }
      if (kind === "tickets") {
        const supplied = String(raw.ticketPipelineId || (target ? target.data.ticketPipelineId || "default" : defaultPipeline));
        const pipeline = ticketCatalog(dealStages).pipelines.find(p=>p.id===supplied || p.name.toLowerCase()===supplied.toLowerCase());
        if (!pipeline) throw new Error("Choose an available ticket pipeline.");
        raw.ticketPipelineId = pipeline.id;
        if (raw.ticketStatus) raw.ticketStatus = pipeline.stages.find(s=>s.id===raw.ticketStatus || s.label.toLowerCase()===String(raw.ticketStatus).toLowerCase())?.id ?? raw.ticketStatus;
        else if (target && (target.data.ticketPipelineId || "default") !== pipeline.id) raw.ticketStatus = pipeline.stages[0].id;
      }
      const captions:NonNullable<Data['customLinkText']>={...target?.data.customLinkText};
      mapping.forEach((key,j)=>{
        if(!key.startsWith('linkText:')||!cells[j].trim()||preservedFields.includes('custom:'+key.slice(9)))return;
        const id=key.slice(9),p=properties.find(p=>p.id===id&&p.kind===kind)!;
        const url=custom[id]??target?.data.custom?.[id];
        if(!url)throw Error(`Enter a URL for ${p.label} before adding link text.`);
        captions[id]={url:propertyURLSchema.parse(url),text:linkTextSchema.parse(cells[j])};
      });
      // Leads need their primary link before record validation. Resolve the same
      // association mapping used below, so contact email/company domain imports
      // can satisfy the requirement without inventing or bypassing a prospect.
      if (kind === "leads") {
        const draft = {...target?.data, ...raw} as Data;
        const [linked] = planImportAssociations([{row:i+2,data:draft,target}],rows,mapping,kind,existing,associations,properties);
        if (linked.error) throw new Error(linked.error);
        raw.contactId = linked.data?.contactId;
        raw.companyId = linked.data?.companyId;
        for (const [field,targetKind] of [["contactId","contacts"],["companyId","companies"]] as const)
          if (raw[field] && !existing.some(r=>r.id===raw[field]&&r.kind===targetKind))
            throw new Error("The primary contact or company is unavailable. Import or create it first.");
      }
      const data = parseRecord(
        kind,
        { ...(target?.data || {}), ...raw, custom: { ...(target?.data.custom || {}), ...custom },customLinkText:captions },
        properties,
        dealStages,
        target?.data,
      );
      const key = uniqueKey ? String(data[uniqueKey] ?? "").toLowerCase() : "";
      if(!target && key && seen.has(key)){result.push({row:i+2,skipped:`Existing or repeated ${uniqueKey}: ${key}`});continue;}
      const newClaims=uniqueDefs.flatMap(p=>{const key=uniqueValueKey(data.custom?.[p.id]);return key===null?[]:[{p,key}];});
      for(const {p,key} of newClaims){const holder=claims.get(p.id)!.get(key);if(holder&&holder!==target?.id)throw Error(`Another record or imported row already uses this ${p.label}. Unique values cannot be repeated.`);}
      for(const {p,key} of newClaims)claims.get(p.id)!.set(key,target?.id||'import-row:'+i);
      if (target) {
        if (key && key !== String(target.data[uniqueKey!] || "").trim().toLowerCase() && seen.has(key))
          throw new Error(`Another record or imported row already uses this ${uniqueKey}.`);
        const fields = [...Object.keys(raw), ...Object.keys(custom).map(id => `custom:${id}`),...new Set([...Object.keys(target.data.customLinkText||{}),...Object.keys(data.customLinkText||{})].map(id=>'linkText:'+id))];
        const changes = fields.flatMap(field => {
          const before = propertyValue(target.data,field);
          const after = propertyValue(data,field);
          return samePropertyValue(before, after) ? [] : [{ field, before, after }];
        });
        if (key) seen.add(key);
        result.push(changes.length ? { row: i + 2, data, target, changes,...(preservedFields.length?{preservedFields}:{}) } : { row: i + 2, target, skipped: "No property changes",...(preservedFields.length?{preservedFields}:{}) });
      } else if (key && seen.has(key))
        result.push({
          row: i + 2,
          skipped: `Existing or repeated ${uniqueKey}: ${key}`,
        });
      else {
        if (key) seen.add(key);
        result.push({ row: i + 2, data });
      }
    } catch (e) {
      result.push({
        row: i + 2,
        error:
          e instanceof Error
            ? "issues" in e
              ? (e as { issues: { message: string }[] }).issues[0].message
              : e.message
            : "Check this row.",
      });
    }
  }
  return planImportAssociations(result,rows,mapping,kind,existing,associations,properties);
}
