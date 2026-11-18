"use client";
import { useState } from "react";
import { ArrowUp, ArrowDown, Plus, X } from "lucide-react";
import type { Kind } from "@/lib/crm";
import type { Property } from "@/lib/workspace";
import { standardOptions, standardOptionsInput } from "@/lib/standard-options";
import { Dialog } from "./workspace-tools";
export function StandardOptionsDialog({ kind, field, properties, onSaved, onClose }: {
  kind: Kind; field: string; properties: Property[]; onSaved: () => Promise<void>; onClose: () => void;
}) {
  const initial = standardOptions(kind, field, properties);
  const [saved, setSaved] = useState(initial), [options, setOptions] = useState(initial.options);
  const [addition, setAddition] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  function add() {
    const option = addition.trim();
    const checked = standardOptionsInput.safeParse({ ...saved, options: [...options, option] });
    if (!checked.success) { setError("Enter a unique option name (up to 80 characters, 50 choices total)."); return; }
    setOptions(checked.data.options); setAddition(""); setError("");
  }
  function move(index: number, delta: number) {
    const next = [...options]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; setOptions(next);
  }
  async function reload() {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/standard-options?${new URLSearchParams({kind, field})}`, { cache: "no-store" });
      const data = await r.json() as typeof initial & { error?: string };
      if (!r.ok) throw Error(data.error || "Could not reload options.");
      setSaved(data); setOptions(data.options); setAddition("");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog title={`Options · ${initial.label}`} busy={busy} onClose={onClose}>
    <form onSubmit={async e => {
      e.preventDefault(); if (busy) return;
      if (addition.trim()) { setError("Add the new choice to the list before saving."); return; }
      setBusy(true); setError("");
      try {
        const r = await fetch("/api/standard-options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, field, options, revision: saved.revision }) });
        const data = await r.json() as typeof initial & { error?: string };
        if (!r.ok) throw Error(data.error || "Could not save options.");
        setSaved(data); await onSaved(); onClose();
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}>
      <div className="tool-body">
        <p className="form-intro">Add and order choices for {initial.label} across your {kind}. Existing values remain unchanged so records and saved rules keep working.</p>
        <p className="muted">Saved choices cannot be renamed or removed here. New choices become available after saving; Cancel discards this draft.</p>
        <ol className="standard-option-list">{options.map((option, index) => <li key={option}><span>{option}</span><div>
          <button type="button" className="icon-button" disabled={busy || index === 0} aria-label={`Move ${option} up`} onClick={() => move(index,-1)}><ArrowUp size={15}/></button>
          <button type="button" className="icon-button" disabled={busy || index === options.length - 1} aria-label={`Move ${option} down`} onClick={() => move(index,1)}><ArrowDown size={15}/></button>
          {!saved.options.includes(option) && <button type="button" className="icon-button" disabled={busy} aria-label={`Remove unsaved ${option}`} onClick={() => setOptions(options.filter(o => o !== option))}><X size={15}/></button>}
        </div></li>)}</ol>
        <label className="form-field">New option<input maxLength={80} disabled={busy || options.length >= 50} value={addition} onChange={e => setAddition(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /></label>
        <button type="button" className="secondary" disabled={busy || options.length >= 50} onClick={add}><Plus size={14}/>Add option</button>
        <p className="muted">{options.length}/50 choices. This order controls dropdowns and default board lanes; saved lane order remains unchanged.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="button" className="text-button" disabled={busy} onClick={() => void reload()}>Reload options and discard draft</button>
      </div>
      <footer className="preview-footer"><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save options"}</button><button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button></footer>
    </form>
  </Dialog>;
}
