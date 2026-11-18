"use client";
import {ImportProtection} from "./import-protection";
import {ImportPropertyDialog} from "./import-property";
import {DateDisplayChoices,StandardDateDisplayDialog} from "./property-date-display";
import { DateTimeInput } from "./property-datetime";
import {PropertyLogicDialog} from "./property-logic";
import {isPropertyLogicKind} from "@/lib/property-logic";
import {PropertyValidationEditor,PropertyValidationHint} from "./property-validation";
import type {ValidationRules} from "@/lib/property-validation";
import {customTextLimit,isTextProperty} from "@/lib/property-text";
import {PropertyArchiveDialog} from "./property-archive";
import {HistoryExportDialog} from './history-export-dialog';
import {PropertyDefinitionHistory} from './property-definition-history';
import {PropertyUsageDialog} from './property-usage';
import {PropertyDefinitionExport} from './property-definition-export';
import {PropertyOrganization} from './property-groups';
import {recordLayoutFields} from '@/lib/record-layout';
import {editableProperties} from '@/lib/record-properties';
import { MultipleChoice } from "./multiple-choice";
import { associationImportFieldCatalog } from "@/lib/import-associations";
import { ImportHistory } from "./import-history";
import { StandardOptionsDialog } from "./standard-options";
import { PropertyColorDialog } from "./property-color-dialog";
import { usePropertyColors } from "./property-colors";
import { colorableFields } from "@/lib/property-colors";
import type { FilterField } from "@/lib/filters";
import { standardField } from "@/lib/standard-properties";
import {standardSettingDefinition} from '@/lib/standard-property-settings';
import { filterFields } from "@/lib/filters";
import { ticketCatalog } from "@/lib/ticket-pipelines";
import { pipelineList } from "@/lib/forecast";
import { usePipelineCatalog } from "./pipeline-context";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { X, Upload, Check, Plus } from "lucide-react";
import { type CRMRecord, type Kind } from "@/lib/crm";
import {
  propertyTypes,
  propertyText,
  type Property,
  type SavedView,
  type ViewConfig,
} from "@/lib/workspace";
import { autoMap, captionImportFields, importCounts, importFields, ownerMemberImportField, parseCSV, type ImportRow, type ImportMode } from "@/lib/csv-import";
export type Mutate = (
  payload: unknown,
  message: string,
) => Promise<{
  id?: string;
  ok?: boolean;
  created?: number;
  updated?: number;
  skipped?: number;
  importId?: string;
  associationsAdded?: number;
  associationsUpdated?: number;
} | null>;
export function Dialog({
  title,
  onClose,
  busy,
  children,
  returnFocus,
}: {
  title: string;
  onClose: () => void;
  busy: boolean;
  children: React.ReactNode;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = returnFocus?.current || opener;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (target?.isConnected) target.focus();
    };
  }, [returnFocus]);
  return (
      <dialog
        ref={dialogRef}
        className="tool-dialog panel"
        tabIndex={-1}
        aria-modal="true"
        aria-label={title}
        onKeyDown={event => {
          if (event.key === "Escape") event.stopPropagation();
          if (event.key !== "Tab" || !(event.target instanceof Element) || event.target.closest('dialog') !== event.currentTarget) return;
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex],[contenteditable="true"]'))
            .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') && element.getClientRects().length > 0);
          const first = controls[0], last = controls[controls.length - 1];
          if (!first) { event.preventDefault(); event.currentTarget.focus(); }
          else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first.focus(); }
        }}
        onCancel={event => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          event.stopPropagation();
          if (!busy) onClose();
        }}
      >
        <header className="editor-heading">
          <h2>{title}</h2>
          <button onClick={onClose} disabled={busy} aria-label="Close dialog">
            <X size={20} />
          </button>
        </header>
        {children}
      </dialog>
  );
}
export function PropertyControl({
  property: p,
  saved = false,
  required = false,
  value,
  onChange,
}: {
  property: Property;
  saved?: boolean;
  required?: boolean;
  value: unknown;
  onChange: (v: string | number | boolean | string[]) => void;
}) {
  if (p.type === "multiselect") return <div title={p.description}><MultipleChoice label={p.label} options={p.options} value={value} onChange={onChange} required={required} />{p.description&&<small className="muted">{p.description}</small>}</div>;
  return (
    <label className="form-field" title={p.description}>
      {p.label}{required && <span className="required"> *</span>}
      {p.type === "datetime" ? <DateTimeInput label={p.label} value={value} onChange={onChange} required={required}/> : p.type === "select" || p.type === "checkbox" ? (
        <select
          required={required}
          value={value === undefined ? "" : String(value)}
          onChange={(e) =>
            onChange(
              p.type === "checkbox" && e.target.value !== ""
                ? e.target.value === "true"
                : e.target.value,
            )
          }
        >
          <option value="">Not set</option>
          {(p.type === "checkbox" ? ["true", "false"] : p.options).map((o) => (
            <option key={o} value={o}>
              {p.type === "checkbox" ? (o === "true" ? "Yes" : "No") : o}
            </option>
          ))}
        </select>
      ) : p.type === "textarea" || isTextProperty(p.type) && /[\r\n]/.test(String(value ?? "")) ? (
        <textarea required={required} rows={5} maxLength={customTextLimit} value={String(value ?? "")} onChange={e=>onChange(e.target.value)} />
      ) : (
        <input
          required={required}
          type={
            p.type === "email" ? "email" : p.type === "number" ? "number" : p.type === "date" ? "date" : "text"
          }
          step={p.type === "number" ? "any" : undefined}
          onInput={p.type === "date" ? e=>onChange(e.currentTarget.value) : undefined}
          inputMode={p.type === "url" ? "url" : undefined}
          placeholder={p.type === "url" ? "https://example.com" : p.type === "email" ? "name@example.com" : undefined}
          maxLength={isTextProperty(p.type) ? customTextLimit : p.type === "url" ? 2048 : p.type === "email" ? 254 : 2000}
          value={String(value ?? "")}
          onChange={(e) =>
            onChange(
              p.type === "number" && !p.uniqueValues && e.target.value !== ""
                ? Number(e.target.value)
                : e.target.value,
            )
          }
        />
      )}
      {p.uniqueValues&&p.type==='number'&&<small className="form-hint">Use text for long account IDs or high-precision identifiers. Numeric IDs must round-trip exactly and be within ±9,007,199,254,740,991.</small>}
      <PropertyValidationHint field={p} value={value} saved={saved}/>
    </label>
  );
}
export function PropertiesDialog({
  kind,
  startCreating = false,
  returnFocus,
  properties,
  busy,
  error,
  mutate,
  onClose,
  onDefinitionsChanged,
}: {
  kind: Kind;
  startCreating?: boolean;
  returnFocus?: RefObject<HTMLElement | null>;
  properties: Property[];
  busy: boolean;
  error: string;
  mutate: Mutate;
  onClose: () => void;
  onDefinitionsChanged: () => Promise<void>;
}) {
  const createName = useRef<HTMLInputElement>(null);
  useEffect(()=>{if(!startCreating)return;const frame=requestAnimationFrame(()=>{createName.current?.scrollIntoView({block:'center'});createName.current?.focus({preventScroll:true});});return()=>cancelAnimationFrame(frame);},[startCreating]);
  const [logicOpen,setLogicOpen]=useState(false);
  const [archiveProperty,setArchiveProperty]=useState<Property|null|undefined>(undefined);
  const [definitionHistory,setDefinitionHistory]=useState<Property|null>(null);
  const [uniqueValues,setUniqueValues]=useState(false);
  const [validation,setValidation]=useState<ValidationRules|null>(null);
  const [description,setDescription]=useState("");
  const [showRelativeTime,setShowRelativeTime]=useState(false),[dateDisplayField,setDateDisplayField]=useState<FilterField|null>(null);
  const [linkText,setLinkText]=useState(""),[allowCustomLinkText,setAllowCustomLinkText]=useState(false);
  const [usageField, setUsageField] = useState<FilterField|null>(null);
  const [definitionExport, setDefinitionExport] = useState<FilterField[] | null | undefined>(undefined);
  const [exportField,setExportField]=useState<FilterField|null>(null);
  const [optionField, setOptionField] = useState("");
  const catalog = usePipelineCatalog();
  const [colorField, setColorField] = useState<FilterField | null>(null);
  const colorContext = usePropertyColors();
  const colorFields = colorableFields(kind, properties);
  const organizationFields = recordLayoutFields(kind, properties, catalog);
  const [label, setLabel] = useState(""),
    [type, setType] = useState<Property["type"]>("text"),
    [options, setOptions] = useState(""),
    [editing, setEditing] = useState<Property | null>(null);
  if(logicOpen&&isPropertyLogicKind(kind))return <PropertyLogicDialog kind={kind} properties={properties} onClose={()=>setLogicOpen(false)} onSaved={onDefinitionsChanged}/>;
  if(archiveProperty!==undefined)return <PropertyArchiveDialog kind={kind} property={archiveProperty||undefined} onClose={()=>setArchiveProperty(undefined)} onSaved={onDefinitionsChanged} onUsage={p=>{setArchiveProperty(undefined);setUsageField({id:'custom:'+p.id,label:p.label,type:p.type==='textarea'?'text':p.type});}}/>;
  if(definitionHistory)return <PropertyDefinitionHistory kind={kind} property={definitionHistory} onClose={()=>setDefinitionHistory(null)}/>;
  if(usageField)return <PropertyUsageDialog kind={kind} field={usageField} onClose={()=>setUsageField(null)} onNavigate={onClose}/>;
  if(definitionExport !== undefined) return <PropertyDefinitionExport kind={kind} selected={definitionExport} onClose={() => setDefinitionExport(undefined)} />;
  if(exportField)return <HistoryExportDialog kind={kind} field={exportField} onClose={()=>setExportField(null)}/>;
  const storedFields=editableProperties(kind,properties,catalog);
  const exportButton=(id:string)=>{const field=storedFields.find(f=>f.id===id);return field&&<button className="text-button" aria-label={`Export history for ${field.label}`} onClick={()=>setExportField(field)}>Export history</button>;};
  if(dateDisplayField)return <StandardDateDisplayDialog kind={kind} field={dateDisplayField} properties={properties} onSaved={onDefinitionsChanged} onClose={()=>setDateDisplayField(null)}/>;
  if (optionField) return <StandardOptionsDialog kind={kind} field={optionField} properties={properties} onClose={() => setOptionField("")} onSaved={onDefinitionsChanged} />;
  if (colorField) return <PropertyColorDialog kind={kind} field={colorField} onClose={() => setColorField(null)} />;
  function colorButton(id: string) {
    const field = colorFields.find(f => f.id === id);
    return field && <button className="text-button" aria-label={`Edit colors for ${field.label}`} disabled={busy || colorContext.loading || !!colorContext.error} onClick={() => setColorField(field)}>Colors</button>;
  }
  return (
    <Dialog title={`Properties · ${kind}`} busy={busy} onClose={onClose} returnFocus={returnFocus}>
      <div className="tool-body">
        <p className="form-intro">
          Add the details your team cares about. Properties appear on records,
          in tables, and in CSV mapping.
        </p>
        {isPropertyLogicKind(kind)&&<button className="secondary" disabled={busy} onClick={()=>setLogicOpen(true)}>Conditional logic</button>}
        <button className="secondary" disabled={busy} onClick={()=>setArchiveProperty(null)}>Archived properties</button>
        <PropertyOrganization onExport={setDefinitionExport} kind={kind} fields={organizationFields} editableIds={storedFields.map(f => f.id)} disabled={busy} actions={f => {
          const p = f.id.startsWith('custom:') ? properties.find(p => p.id === f.id.slice(7) && p.kind === kind) : null;
          const historyProperty=p||standardSettingDefinition(kind,f.id,properties.find(v=>v.kind===kind&&v.standardField===f.id));
          return <>
            {p && <button className="text-button" disabled={busy} aria-label={`Edit definition of ${p.label}`} onClick={() => { setEditing(p); setShowRelativeTime(!!p.showRelativeTime); setLinkText(p.linkText||"");setAllowCustomLinkText(!!p.allowCustomLinkText); setUniqueValues(!!p.uniqueValues); setValidation(p.validation||null); setLabel(p.label); setDescription(p.description||""); setType(p.type); setOptions(p.options.join('\n')); }}>Edit definition</button>}
            {!p&&['date','datetime'].includes(f.type)&&<button className="text-button" disabled={busy} aria-label={`Date display for ${f.label}`} onClick={()=>setDateDisplayField(f)}>Date display</button>}
            {standardField(kind, f.id)?.type === 'select' && <button className="text-button" aria-label={`Edit options for ${f.label}`} disabled={busy} onClick={() => setOptionField(f.id)}>Options</button>}
            {p&&<button className="text-button" disabled={busy} aria-label={`Archive ${p.label}`} onClick={()=>{setEditing(null);setArchiveProperty(p);}}>Archive</button>}
            {historyProperty&&<button className="text-button" disabled={busy} aria-label={`Definition history of ${f.label}`} onClick={()=>setDefinitionHistory(historyProperty)}>Definition history</button>}{colorButton(f.id)}{exportButton(f.id)}<button className="text-button" disabled={busy} aria-label={`View usage of ${f.label}`} onClick={()=>setUsageField(f)}>View usage</button>
          </>;
        }} />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await mutate(
                {
                  action: "property",
                  id: editing?.id,
                  revision: editing?.revision,
                  description,
                  ...(["date","datetime"].includes(type)?{showRelativeTime}:{}),
                  ...(type==="url"?{linkText,allowCustomLinkText}:{}),
                  validation,
                  uniqueValues,
                  kind,
                  label,
                  type,
                  options:
                    ["select", "multiselect"].includes(type)
                      ? options
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean)
                      : [],
                },
                editing ? "Property definition updated" : "Property created",
              )
            ) {
              setLabel("");
              setDescription("");
              setValidation(null);setUniqueValues(false);setLinkText("");setAllowCustomLinkText(false);setShowRelativeTime(false);
              setOptions("");
              setType("text");
              setEditing(null);
            }
          }}
        >
          <h3>{editing ? "Edit property definition" : "New property"}</h3>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <label className="form-field">
            Property name
            <input
              ref={createName}
              required
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className="form-field">Description<textarea rows={3} maxLength={1000} value={description} onChange={e=>setDescription(e.target.value)} placeholder="Explain what this field means and how to use it." /></label>
          <label className="form-field">
            Property type
            <select
              disabled={!!editing && !isTextProperty(editing.type)}
              value={type}
              onChange={(e) => { const next=e.target.value as Property["type"]; if(!(isTextProperty(type)&&isTextProperty(next)))setValidation(null);if(next!=="url"){setLinkText("");setAllowCustomLinkText(false);setShowRelativeTime(false);}if(!["text","textarea","number"].includes(next))setUniqueValues(false);setType(next); }}
            >
              {propertyTypes.filter(t=>!editing || !isTextProperty(editing.type) || isTextProperty(t)).map((t) => (
                <option key={t} value={t}>
                  {
                    {
                      text: "Single-line text",
                      textarea: "Multi-line text",
                      url: "URL",
                      email: "Email",
                      datetime: "Date and time",
                      number: "Number",
                      date: "Date",
                      checkbox: "Yes / No",
                      select: "Dropdown",
                      multiselect: "Multiple checkboxes",
                    }[t]
                  }
                </option>
              ))}
            </select>
          </label>
          {["select", "multiselect"].includes(type) && (
            <label className="form-field">
              Options (one per line)
              <textarea
                required
                disabled={!!editing}
                rows={4}
                value={options}
                onChange={(e) => setOptions(e.target.value)}
              />
            </label>
          )}
          {["text","textarea","number"].includes(type)&&<div>
            <label><input type="checkbox" checked={uniqueValues} disabled={!!editing} onChange={e=>setUniqueValues(e.target.checked)}/> Require unique values</label>
            <p className="form-intro">Set at creation only. Up to ten per object, including archived properties. Text is case-sensitive and spaces count; numbers compare numerically. Empty values are allowed. Enforced in imports, workflows and API writes too.</p>
          </div>}
          <PropertyValidationEditor key={`${editing?.id||"new"}:${type}`} type={type} value={validation} onChange={setValidation}/>
          {isTextProperty(type) && <p className="form-intro">Plain text, up to {validation?.regex!==undefined?'1,000':'65,536'} characters per field and 800 KB total record data. Switching between single-line and multi-line text keeps every saved value and line break.</p>}
          {["date","datetime"].includes(type)&&<DateDisplayChoices value={showRelativeTime} onChange={setShowRelativeTime}/>}
          {type === "url" && <fieldset className="property-validation-editor"><legend>Link display</legend><label className="form-field">Default link text<input maxLength={200} placeholder="Show the URL" value={linkText} onChange={e=>setLinkText(e.target.value)}/></label><label><input type="checkbox" checked={allowCustomLinkText} onChange={e=>setAllowCustomLinkText(e.target.checked)}/> Allow custom link text on individual records</label><p className="form-intro">Captions change how links display in tables and records. Filters, reports and exports still use the URL. Disabling custom text shows the default without deleting saved captions.</p></fieldset>}
          {type === "url" && <p className="form-intro">Store a clickable HTTP or HTTPS link. A missing https:// is added automatically. Links open in a new tab.</p>}
          {type === "email" && <p className="form-intro">Store one email address. Custom email fields do not change recipients for email sent from Harbor.</p>}
          {type === "datetime" && <p className="form-intro">Dates and times display in your device’s time zone; filter pickers use the workspace time zone. For CSV imports and API writes, include the time zone, for example 2026-10-29T14:30:00-04:00. Reports group these values by UTC calendar dates.</p>}
          {type === "multiselect" && <p className="form-intro">Choose several options per record. In CSV files, separate choices with semicolons to replace the selection. Blank import cells keep existing values.</p>}
          <div className="tool-actions">
            <button className="primary" disabled={busy}>
              <Plus size={15} />
              {editing ? "Save definition" : "Create property"}
            </button>
            {editing && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditing(null);
                  setLabel("");
                  setDescription("");
                  setValidation(null);setUniqueValues(false);setLinkText("");setAllowCustomLinkText(false);setShowRelativeTime(false);
                  setOptions("");
                  setType("text");
                }}
              >
                Cancel edit
              </button>
            )}
          </div>
        </form>
      </div>
    </Dialog>
  );
}
export function ImportDialog({
  defaultPipeline = "default",
  kind,
  properties,
  busy,
  error,
  mutate,
  onClose,
  onPropertiesChanged,
}: {
  kind: Kind;
  defaultPipeline?: string;
  properties: Property[];
  busy: boolean;
  error: string;
  mutate: Mutate;
  onClose: () => void;
  onPropertiesChanged: (properties: Property[]) => void;
}) {
  const [history,setHistory]=useState(false);
  const [propertyColumn,setPropertyColumn]=useState<number|null>(null);
  const [importName,setImportName]=useState("CSV import");
  const [previewVersion,setPreviewVersion]=useState(0);
  const [preview,setPreview]=useState<{key:string;rows:ImportRow[];review:string;error:string}|null>(null);
  const stages = usePipelineCatalog();
  const [pipelineId, setPipelineId] = useState(defaultPipeline);
  const [mode, setMode] = useState<ImportMode>("create");
  const [matchProperty,setMatchProperty]=useState("");
  const [doNotOverwrite,setDoNotOverwrite]=useState<string[]>([]);
  const [text, setText] = useState(""),
    [fileName, setFileName] = useState(""),
    [parsed, setParsed] = useState<ReturnType<typeof parseCSV> | null>(null),
    [mapping, setMapping] = useState<string[]>([]),
    [localError, setLocalError] = useState(""),
    [result, setResult] = useState<{ created: number; updated: number; skipped: number; importId?: string; associationsAdded?: number; associationsUpdated?: number } | null>(
      null,
    ),
    [batchId, setBatchId] = useState(() => crypto.randomUUID());
  const previewInput=parsed ? {action:"previewImport",kind,mode,matchProperty:matchProperty||undefined,pipelineId,batchId,mapping,doNotOverwrite:mode==='create'?[]:doNotOverwrite,rows:parsed.rows,historyColumns:parsed.historyColumns} : null;
  const previewKey=JSON.stringify([previewInput,previewVersion]);
  const previewBody=JSON.stringify(previewInput);
  useEffect(()=>{
    if(previewBody==="null")return;
    const controller=new AbortController();
    const timer=setTimeout(async()=>{try {
      const res=await fetch("/api/crm",{method:"POST",headers:{"Content-Type":"application/json"},body:previewBody,signal:controller.signal});
      const value=await res.json() as {rows:ImportRow[];review:string;error:string};
      if(!res.ok)throw Error(value.error||"Could not preview import.");
      if(!controller.signal.aborted)setPreview({...value,key:previewKey});
    }catch(error){if(!controller.signal.aborted)setPreview({key:previewKey,rows:[],review:"",error:error instanceof Error?error.message:"Could not preview import."});}},200);
    return()=>{clearTimeout(timer);controller.abort();};
  },[previewKey,previewBody]);
  const plan=preview?.key===previewKey?preview:null;
  const refreshing=!!parsed&&!plan;
  const counts = importCounts(plan?.rows ?? []), ready = counts.ready;
  function review() {
    try {
      const csv = parseCSV(text);
      setParsed(csv);
      if(csv.historyColumns?.length)setMode("update");
      setMapping(autoMap(csv.headers, kind, properties));
      setDoNotOverwrite([]);
      setBatchId(crypto.randomUUID());
      setLocalError("");
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Could not read CSV.");
    }
  }
  return (
    <Dialog title={`Import ${kind}`} busy={busy} onClose={onClose}>
      {propertyColumn!==null&&parsed&&<ImportPropertyDialog header={parsed.headers[propertyColumn]} kinds={[kind]} values={parsed.rows.map(r=>r[propertyColumn]||'')} onCatalog={properties=>{onPropertiesChanged(properties);setPreviewVersion(v=>v+1);}} onClose={()=>setPropertyColumn(null)} onCreated={property=>{onPropertiesChanged([...properties.filter(p=>p.id!==property.id),property]);setDoNotOverwrite(v=>v.filter(f=>f!==mapping[propertyColumn]));setMapping(v=>v.map((field,i)=>i===propertyColumn?'custom:'+property.id:field));setBatchId(crypto.randomUUID());setPreviewVersion(v=>v+1);setPropertyColumn(null);}}/>}
      <div className="tool-body">
        {history ? <ImportHistory kind={kind} initialId={result?.importId} onBack={()=>{setHistory(false);if(result){setResult(null);setParsed(null);setText("");setFileName("");setImportName("CSV import");setBatchId(crypto.randomUUID());}}} onClose={onClose}/> : result ? (
          <div className="import-success">
            <Check size={36} />
            <h2>Import complete</h2>
            <p>
              {result.created} created · {result.updated} updated · {result.skipped} skipped.
              {(result.associationsAdded || result.associationsUpdated) ? ` ${result.associationsAdded || 0} associations added · ${result.associationsUpdated || 0} labels updated.` : ""}
            </p>
            <button className="secondary" onClick={()=>setHistory(true)}>View import history</button>
            <button className="primary" onClick={onClose}>
              View {kind}
            </button>
          </div>
        ) : (
          <>
            <button className="text-button" disabled={busy} onClick={()=>setHistory(true)}>View import history</button>
            <p><a href={`/imports?kind=${kind}`} target="_blank" rel="noopener noreferrer">Import a larger CSV with saved progress ↗</a></p>
            <label className="form-field">Import name<input maxLength={120} value={importName} disabled={busy} onChange={e=>setImportName(e.target.value)}/></label>
            {!!parsed?.historyColumns?.length&&<p className="muted">Harbor history values detected. Marked columns restore their exact values; ~empty clears a property and blank historical slots are skipped. Review every proposed change.</p>}
            {kind==='deals'&&<p className="muted">Enabled forecast-category mappings apply to new deals without a category and to stage/pipeline changes. A mapped move replaces any Forecast category supplied in that same row. Category-only updates retain your value.</p>}
            <label className="form-field">How to import
              <select aria-label="Import mode" value={mode} disabled={busy} onChange={e => { setMode(e.target.value as ImportMode); setBatchId(crypto.randomUUID()); }}>
                <option value="create">Create new records only</option>
                <option value="update">Update existing records only</option>
                <option value="upsert">Create and update records</option>
              </select>
            </label>
            {!!properties.some(p=>p.kind===kind&&p.uniqueValues&&!p.archivedAt)&&<label className="form-field">Match existing records by
              <select aria-label="Import matching property" disabled={busy} value={matchProperty} onChange={e=>{setMatchProperty(e.target.value);setBatchId(crypto.randomUUID());}}>
                <option value="">Record ID, then {kind==='contacts'?'email':kind==='companies'?'company domain':'no automatic match'}</option>
                {properties.filter(p=>p.kind===kind&&p.uniqueValues&&!p.archivedAt).map(p=><option key={p.id} value={p.id}>{p.label} (unique)</option>)}
              </select>
              <small>Record ID takes priority when mapped. Map the selected property too. Text matching is case-sensitive; blank identifiers do not match existing records.</small>
            </label>}
            {(kind === "deals" || kind === "tickets") && (
              <label className="form-field">
                Default pipeline
                <select
                  aria-label="Import pipeline"
                  value={pipelineId}
                  disabled={busy}
                  onChange={(e) => {
                    setPipelineId(e.target.value);
                    setBatchId(crypto.randomUUID());
                  }}
                >
                  {(kind === "tickets" ? ticketCatalog(stages).pipelines : pipelineList(stages)).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <small>
                  Used when a row has no pipeline. Map Pipeline to import by
                  name or ID.
                </small>
              </label>
            )}
            {(kind==='contacts'||kind==='companies')&&<p><a href="/imports/contacts-companies">Import contacts and companies from one CSV ↗</a></p>}
            {kind==='contacts'&&<p className="muted">New contacts use the mapped Name when provided, otherwise First name + Last name, then Email. You do not need a separate Name column. Existing contact names change only when a nonblank Name is mapped.</p>}
            <p className="form-intro">
              Upload → map columns → review → import. Up to 500 records / 2 MB.
              Match by Record ID, contact email, company domain, or a selected custom unique property. Blank cells preserve existing values.
              Map Record owner (workspace member) to an active member email, ID or unambiguous name. Blank cells keep the owner; [clear] unassigns it. Stored owner text does not establish a member assignment.
              Record ID takes priority; a blank mapped ID starts a new record (or is skipped in update-only mode).
              URL fields with custom link text enabled have a separate caption mapping. Blank captions keep existing text when the URL stays the same. Replacing a URL without a new caption clears its old text. A caption needs a URL on the row or existing record.
              Map Associated company domains, Associated contact emails, custom unique identifiers or Associated Record IDs to link existing records. Separate standard identifiers and labels with semicolons. Custom unique identifiers match exactly, including spaces and semicolons. For multiple custom IDs, select the JSON list mapping and supply an array such as ["C-001","C-002"]. Labels are added to existing labels. Primary selects one supported primary relationship; blank cells keep existing links. Related records must already exist; imports do not create both sides together.
            </p>
            {(localError || error || plan?.error) && (
              <p className="form-error" role="alert">
                {localError || error || plan?.error}
              </p>
            )}
            {!parsed ? (
              <>
                <label className="csv-upload">
                  <Upload size={24} />
                  <b>{fileName || "Choose a CSV file"}</b>
                  <input
                    aria-label="CSV file"
                    type="file"
                    accept=".csv,text/csv"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (f.size > 2_000_000) {
                        setLocalError("Choose a CSV smaller than 2 MB.");
                        return;
                      }
                      try {
                        setText(await f.text());
                        setFileName(f.name);
                        setImportName(f.name.slice(0,120));
                        setLocalError("");
                      } catch {
                        setLocalError("Could not read this file.");
                      }
                    }}
                  />
                </label>
                <label className="form-field">
                  Or paste CSV
                  <textarea
                    rows={6}
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      setFileName("");
                    }}
                    placeholder="Name,Email,Phone"
                  />
                </label>
                <button
                  className="primary"
                  disabled={!text.trim()}
                  onClick={review}
                >
                  Review CSV
                </button>
              </>
            ) : (
              <>
                <div className="import-summary">
                  <b>{parsed.rows.length} rows</b>
                  <span>{counts.created} creates</span>
                  <span>{counts.updated} updates</span>
                  <span>{counts.skipped} skipped</span>
                  <span>{counts.errors} errors</span>
                  <button className="text-button" disabled={busy || refreshing} onClick={()=>{setPreviewVersion(v=>v+1);setLocalError("");}}>{refreshing ? "Refreshing…" : "Refresh preview"}</button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setParsed(null);
                      setLocalError("");
                    }}
                  >
                    Change file
                  </button>
                </div>
                {mode!=="create"&&!parsed.historyColumns?.length&&<p className="form-hint">Don’t overwrite keeps current values and values recorded in property history, even if now cleared. New records still receive the CSV values. It applies to the selected property; a protected URL keeps its link text too.</p>}
                <div className="mapping-grid">
                  {parsed.headers.map((h, i) => (
                    <div className="form-field" key={i}><label>
                      {h || `Column ${i + 1}`}
                      <small>Example: {parsed.rows[0][i] || "(empty)"}</small>
                      <select
                        aria-label={`Map column ${i + 1}: ${h}`}
                        disabled={busy}
                        value={mapping[i]}
                        onChange={(e) => {
                          setDoNotOverwrite(v=>v.filter(f=>f!==mapping[i]&&f!==e.target.value));
                          setMapping((m) =>
                            m.map((v, j) => (i === j ? e.target.value : v)),
                          );
                          setBatchId(crypto.randomUUID());
                        }}
                      >
                        <option value="">Skip column</option>
                        <option value="recordId">Record ID</option>
                        <option value={ownerMemberImportField.id}>{ownerMemberImportField.label}</option>
                        {!!captionImportFields(kind,properties).length&&<optgroup label="URL link text">{captionImportFields(kind,properties).map(f=><option key={f.id} value={f.id}>{f.label}</option>)}</optgroup>}
                        <optgroup label="Associations to existing records">{associationImportFieldCatalog(properties).map(f=><option key={f.id} value={f.id}>{f.label}</option>)}</optgroup>
                        {importFields[kind].map((f) => (
                          <option key={f} value={f}>
                            {f==="owner"?"Record owner (stored text)":standardField(kind, f)?.label ?? f.replace(/([A-Z])/g, " $1")}
                          </option>
                        ))}
                        {properties
                          .filter((p) => !p.standardField && p.kind === kind)
                          .map((p) => (
                            <option key={p.id} value={`custom:${p.id}`}>
                              {p.label} (custom)
                            </option>
                          ))}
                      </select></label>
                      {!parsed.historyColumns?.length&&<button className="text-button import-create-property" type="button" disabled={busy} onClick={()=>setPropertyColumn(i)} aria-label={`Create property for column ${i+1}: ${h}`}>Create new property</button>}
                      {mode!=="create"&&!parsed.historyColumns?.length&&<ImportProtection field={mapping[i]} header={h} index={i} selected={doNotOverwrite} disabled={busy} onChange={v=>{setDoNotOverwrite(v);setBatchId(crypto.randomUUID());}}/>}
                    </div>
                  ))}
                </div>
                <div className="import-preview">
                  <table>
                    <thead>
                      <tr>
                        <th>CSV row</th>
                        <th>Name</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan?.rows.map((r) => (
                        <tr key={r.row}>
                          <td>{r.row}</td>
                          <td>
                            {r.data?.name ?? r.target?.data.name ??
                              parsed.rows[r.row - 2][mapping.indexOf("name")]}
                          </td>
                          <td className={r.error ? "form-error" : ""}>
                            {r.error || r.skipped || (r.target ? "Ready to update" : "Ready to create")}
                            {!!r.preservedFields?.length&&<p>Kept existing or previously populated: {r.preservedFields.map(f=>f==='ownerMember'?'Record owner':f.startsWith('custom:')?properties.find(p=>p.id===f.slice(7))?.label??f:standardField(kind,f)?.label??f).join(', ')}.</p>}
                            {r.ownerAssignment!==undefined&&<p>{r.ownerAssignment?<>Owner: <b>{r.ownerAssignment.name}</b> · {r.ownerAssignment.email||r.ownerAssignment.id}</>:"Owner: Unassigned"}</p>}
                            {r.associations?.length ? <details className="import-changes"><summary>{r.associations.length} {r.associations.length === 1 ? "association" : "associations"} to review</summary><ul>{r.associations.map(a=><li key={a.targetId}><b>{a.name}</b> ({a.kind}){a.identifier&&<> · Matched on {a.identifier.label}: <code>{String(a.identifier.value).length>160?String(a.identifier.value).slice(0,160)+"…":String(a.identifier.value)}</code></>} · {a.previous ? a.changed ? "Update association" : "Already linked" : "Add association"}{a.labels.length ? ` · Labels: ${a.labels.join(", ")}` : ""}{a.primary ? ` · ${a.primary === "companyId" ? "Primary company" : a.primary === "contactId" ? "Primary contact" : "Primary related record"}: ${a.primaryBefore} → ${a.name}${a.primaryBefore !== "None" && a.primaryBefore !== a.name ? " (previous primary remains linked)" : ""}` : ""}</li>)}</ul></details> : null}
                            {!r.target&&r.data?.customLinkText&&<details className="import-changes"><summary>Link captions to create</summary><ul>{Object.entries(r.data.customLinkText).map(([id,caption])=><li key={id}><b>{properties.find(p=>p.id===id)?.label||id}</b>: {caption.text} · {caption.url}</li>)}</ul></details>}
                            {r.changes && <details className="import-changes"><summary>{r.changes.length} property changes</summary><ul>{r.changes.map(change => <li key={change.field}><b>{change.field.startsWith('linkText:')?`${properties.find(p=>p.id===change.field.slice(9))?.label||change.field} link text`:change.field.startsWith("custom:") ? properties.find(p => p.id === change.field.slice(7))?.label || change.field : change.field}</b>: {propertyText(change.before) || "(empty)"} → {propertyText(change.after) || "(empty)"}{change.field.startsWith('linkText:')&&r.data?.custom?.[change.field.slice(9)]&&<> · URL: {String(r.data.custom[change.field.slice(9)])}</>}</li>)}</ul></details>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!!counts.errors && (
                  <p className="form-error">
                    Correct the source file and review again. Nothing is
                    imported while any row has an error.
                  </p>
                )}
                <div className="tool-actions">
                  <button
                    className="primary"
                    disabled={
                      busy || refreshing || !importName.trim() || !ready || !!counts.errors || !!plan?.error
                    }
                    onClick={async () => {
                      const saved = await mutate(
                        {
                          action: "import",
                          name: importName.trim(),
                          mode,
                          matchProperty:matchProperty||undefined,
                          review: plan?.review,
                          pipelineId,
                          kind,
                          rows: parsed.rows,
                          historyColumns: parsed.historyColumns,
                          doNotOverwrite:mode==='create'?[]:doNotOverwrite,
                          mapping,
                          batchId,
                        },
                        "CSV import complete",
                      );
                      if (saved)
                        setResult({
                          importId: saved.importId,
                          associationsAdded: saved.associationsAdded,
                          associationsUpdated: saved.associationsUpdated,
                          created: saved.created ?? 0,
                          updated: saved.updated ?? 0,
                          skipped: saved.skipped ?? 0,
                        });
                    }}
                  >
                    {busy ? "Importing…" : `Import ${ready} ${ready === 1 ? "record" : "records"}`}
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={onClose}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
export function SaveViewDialog({
  kind,
  config,
  existing,
  busy,
  error,
  mutate,
  onClose,
  onSaved,
}: {
  kind: Kind;
  config: ViewConfig;
  existing?: SavedView;
  busy: boolean;
  error: string;
  mutate: Mutate;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  return (
    <Dialog
      title={existing ? "Update saved view" : "Save a view"}
      onClose={onClose}
      busy={busy}
    >
      <form
        className="tool-body"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await mutate(
            { action: "view", id: existing?.id, kind, name, config },
            "View saved",
          );
          if (r?.id) onSaved(r.id);
        }}
      >
        <p className="form-intro">
          Keep this search, filters, sort order, and layout. Your view will be
          available when you return.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <label className="form-field">
          View name
          <input
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Northeast opportunities"
          />
        </label>
        <div className="tool-actions">
          <button className="primary" disabled={busy}>
            Save view
          </button>
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
