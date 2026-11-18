"use client";
import { useEffect, useRef, useState } from "react";
import { dateTimeLocalInstants, dateTimeLocalValue, propertyDateTimeSchema } from "@/lib/property-datetime";

export function DateTimeInput({ value, onChange, label, required, disabled, timeZone, autoFocus = false, invalid, describedBy }: {
  value: unknown; onChange: (value: string) => void; label: string;
  required?: boolean; disabled?: boolean; autoFocus?: boolean; timeZone?: string; invalid?: boolean; describedBy?: string;
}) {
  const [deviceZone, setDeviceZone] = useState("UTC");
  useEffect(() => setDeviceZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"), []);
  const zone = timeZone || deviceZone;
  const text = String(value ?? ""), local = dateTimeLocalValue(text, zone);
  const candidates = local ? dateTimeLocalInstants(local, zone) : [];
  const parsed = propertyDateTimeSchema.safeParse(text);
  const error = !text || parsed.success ? "" : candidates.length > 1
    ? "This time occurs twice. Choose an occurrence."
    : "Choose a valid date and time. This time may not exist because the clocks move forward.";
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.setCustomValidity(error); }, [error]);
  function change(next: string) {
    if (!next) { onChange(""); return; }
    const options = dateTimeLocalInstants(next, zone);
    // Retain exact saved precision and the selected fall-back occurrence.
    const same = parsed.success && options.includes(parsed.data);
    onChange(same ? parsed.data : options.length === 1 ? options[0] : next);
  }
  return <span className="datetime-property-input">
    <input ref={ref} type="datetime-local" step="0.001" aria-label={label} required={required}
      disabled={disabled} autoFocus={autoFocus} value={local} onChange={e => change(e.target.value)} onInput={e => change(e.currentTarget.value)}
      aria-invalid={invalid||!!error} aria-describedby={describedBy}/>
    <small className="form-hint">Time zone: {zone}</small>
    {candidates.length > 1 && <select aria-label={`${label} occurrence`} disabled={disabled}
      value={parsed.success ? parsed.data : ""} onChange={e => onChange(e.target.value || local)} required>
      <option value="">Choose an occurrence</option>
      {candidates.map((at, i) => <option key={at} value={at}>{i === 0 ? "Earlier" : "Later"} ({at})</option>)}
    </select>}
    {error && <small className="form-error" role="alert">{error}</small>}
  </span>;
}
