"use client";
import { useState } from "react";
import type { Kind } from "@/lib/crm";
import type { FilterField } from "@/lib/filters";
import { propertyColorOptions } from "@/lib/property-colors";
import { stageColorOptions, type StageColors, type StageColor } from "@/lib/stage-colors";
import { usePropertyColors } from "./property-colors";
import { Dialog } from "./workspace-tools";

export function PropertyColorDialog({ kind, field, onClose }: { kind: Kind; field: FilterField; onClose: () => void }) {
  const context = usePropertyColors();
  const initial = context.settings.find(s => s.kind === kind && s.field === field.id);
  const [colors, setColors] = useState<StageColors>(initial?.colors ?? {}), [revision, setRevision] = useState(initial?.revision ?? 0);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const disabled = busy || context.loading || !!context.error;
  async function reload() {
    setBusy(true); setError("");
    try { const rows = await context.reload(), setting = rows.find(s => s.kind === kind && s.field === field.id); setColors(setting?.colors ?? {}); setRevision(setting?.revision ?? 0); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not reload colors."); }
    finally { setBusy(false); }
  }
  return <Dialog title={`Property colors · ${field.label}`} busy={busy} onClose={onClose}>
    <form onSubmit={async e => {
      e.preventDefault(); if (disabled) return;
      setBusy(true); setError("");
      try { await context.save({ kind, field: field.id, colors, revision }); onClose(); }
      catch (e) { setError(e instanceof Error ? e.message : "Could not save property colors."); }
      finally { setBusy(false); }
    }}>
      <div className="tool-body">
        <p className="form-intro">Use these option colors in {kind} tables and record property panels. Deal properties also use them on board cards and lanes. Settings apply to every view in your private workspace.</p>
        <div className="property-color-options">{propertyColorOptions(field).map(option => {
          const hex = stageColorOptions.find(c => c.value === colors[option.id])?.hex;
          return <label className="property-color-option" key={option.id}>
            <span className={hex ? "property-color-value" : ""} style={hex ? { backgroundColor: hex + "28", borderColor: hex } : undefined}>{option.label}</span>
            <select aria-label={`Color for ${option.label}`} disabled={disabled} value={colors[option.id] ?? ""} onChange={e => {
              const next = { ...colors }; if (e.target.value) next[option.id] = e.target.value as StageColor; else delete next[option.id]; setColors(next);
            }}><option value="">Default</option>{stageColorOptions.map(c => <option value={c.value} key={c.value}>{c.label}</option>)}</select>
          </label>;
        })}</div>
        <button type="button" className="secondary" disabled={disabled} onClick={() => setColors({})}>Reset all colors</button>
        <p className="muted">Reset restores the default appearance after saving. Colors do not change record values, trigger workflows or change pipeline forecasts.</p>
        {(error || context.error) && <p className="form-error" role="alert">{error || context.error}</p>}
        <button type="button" className="text-button" disabled={busy || context.loading} onClick={() => void reload()}>Reload colors and discard draft</button>
      </div>
      <footer className="preview-footer"><button className="primary" disabled={disabled}>{busy ? "Saving…" : "Save colors"}</button><button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button></footer>
    </form>
  </Dialog>;
}
