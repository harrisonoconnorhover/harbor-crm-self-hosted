"use client";
import { useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { Property } from "@/lib/workspace";
import type { StageProperties } from "@/lib/forecast";
import { stagePropertyFields } from "@/lib/stage-properties";
export function StagePropertySettings({ items, properties, disabled, onChange, title = "Conditional stage properties", kind = "deals", availableFields, objectLabel }: {
  availableFields?:Property[]; objectLabel?:string; kind?: "deals" | "tickets"; title?: string; items: StageProperties[string]; properties: Property[]; disabled: boolean; onChange: (items: StageProperties[string]) => void;
}) {
  const [selected, setSelected] = useState("");
  const fields = availableFields??stagePropertyFields(properties,kind);
  const move = (index: number, offset: number) => { const next = [...items]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; onChange(next); };
  return <section className="stage-usage" aria-label={title}>
    <h3>{title}</h3><p>Show these fields in this order when manually {objectLabel ? `creating or editing a ${objectLabel}` : `creating or moving a ${kind === "tickets" ? "ticket into this status" : "deal into this stage"}`}. Required fields need a value. Imports and workflows use their existing validation.</p>
    {items.map((item, index) => { const label = fields.find(p => p.id === item.field)?.label || item.field; return <div className="stage-property-rule" key={item.field}>
      <span>{label}</span><label><input type="checkbox" disabled={disabled} checked={item.required} onChange={e => onChange(items.map((p, i) => i === index ? { ...p, required: e.target.checked } : p))} /> Required</label>
      <button type="button" disabled={disabled || index === 0} aria-label={`Move ${label} property up`} onClick={() => move(index, -1)}><ArrowUp size={15} /></button>
      <button type="button" disabled={disabled || index === items.length - 1} aria-label={`Move ${label} property down`} onClick={() => move(index, 1)}><ArrowDown size={15} /></button>
      <button type="button" disabled={disabled} aria-label={`Remove ${label} stage property`} onClick={() => onChange(items.filter((_, i) => i !== index))}><X size={15} /></button>
    </div>; })}
    {!items.length && <p>No dependent properties selected.</p>}
    <div className="stage-add-row"><select aria-label="Add stage property" disabled={disabled || items.length >= 20} value={selected} onChange={e => setSelected(e.target.value)}>
      <option value="">Choose a property</option>{fields.filter(p => !items.some(i => i.field === p.id)).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
    </select><button className="secondary" type="button" disabled={disabled || !selected || items.length >= 20} onClick={() => { onChange([...items, { field: selected, required: false }]); setSelected(""); }}>Add property</button></div>
  </section>;
}
