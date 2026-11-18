"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { Kind } from "@/lib/crm";
import type { RecordOption, RecordOptions } from "@/lib/record-options";

const kindLabels = { companies: "Company", contacts: "Contact", deals: "Deal", tasks: "Task", tickets: "Ticket", leads: "Lead" };
export function RecordPicker({ label, kind, value, excludeId = "", disabled, emptyLabel = "No association", signInReturnTo = "/", onChange }: {
  label: string; kind?: Kind; value: string; excludeId?: string; disabled?: boolean; emptyLabel?: string; signInReturnTo?: string; onChange: (id: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const optionList = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [active, setActive] = useState(-1);
  const [attempt, setAttempt] = useState(0);
  const [remembered, setRemembered] = useState<RecordOption | null>(null);
  const key = JSON.stringify({ kind, query, page, selectedId: value, excludeId });
  const [response, setResponse] = useState<{ key: string; attempt: number; data?: RecordOptions; error?: string; authExpired?: boolean } | null>(null);
  const read = open || !!value;
  useEffect(() => {
    if (!read) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/crm/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: controller.signal, cache: "no-store" });
        const data = await res.json() as RecordOptions & { error?: string };
        if (controller.signal.aborted) return;
        if (!res.ok) { setResponse({ key, attempt, error: data.error || "Could not load related records.", authExpired: res.status === 401 }); return; }
        setResponse({ key, attempt, data });
        setRemembered(data.selected);
      } catch (e) { if (!controller.signal.aborted) setResponse({ key, attempt, error: e instanceof Error ? e.message : "Could not load related records." }); }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [read, key, attempt]);
  const current = response?.key === key && response.attempt === attempt ? response : null;
  const data = current?.data;
  const selected = data?.selected ?? (remembered?.id === value ? remembered : null);
  const missing = !!value && !!data && !data.selected;
  const selectedName = !value ? "" : missing ? "Linked record unavailable" : selected?.name || (current?.error ? "Selected link (name unavailable)" : "Loading linked record…");
  const choices = data?.results ?? [];
  const activeOption = active >= 0 && active <= choices.length ? active : -1;
  useEffect(() => {
    if (open && activeOption >= 0) optionList.current?.children[activeOption]?.scrollIntoView({ block: "nearest" });
  }, [open, activeOption]);
  useEffect(() => {
    if (open && data) panel.current?.scrollIntoView({ block: "nearest" });
  }, [open, data]);
  function close() { setOpen(false); setQuery(""); setPage(0); setActive(-1); }
  function choose(record?: RecordOption) { setRemembered(record ?? null); onChange(record?.id || ""); close(); }
  return <div className="form-field record-picker" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) close(); }}>
    <label htmlFor={id}>{label}</label>
    <div className="record-picker-input">
      <Search size={15} aria-hidden="true" />
      <input id={id} ref={input} role="combobox" autoComplete="off" aria-expanded={open} aria-controls={`${id}-choices`} aria-autocomplete="list"
        aria-activedescendant={open && data && activeOption >= 0 ? `${id}-option-${activeOption}` : undefined}
        placeholder={open ? "Search by name, email or domain" : emptyLabel} disabled={disabled}
        value={open ? query : selectedName}
        onFocus={() => setOpen(true)} onChange={e => { setOpen(true); setQuery(e.target.value); setPage(0); setActive(-1); }}
        onKeyDown={e => {
          if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); close(); }
          else if (e.key === "Tab") close();
          else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); setActive(n => !open || n < 0 ? (e.key === "ArrowDown" ? 0 : choices.length) : (n + (e.key === "ArrowDown" ? 1 : choices.length)) % (choices.length + 1)); }
          else if (e.key === "Enter" && open) { e.preventDefault(); if (data && activeOption >= 0) choose(activeOption ? choices[activeOption - 1] : undefined); }
        }} />
      {!!value && <button type="button" aria-label={`Clear ${label.toLowerCase()}`} disabled={disabled} onClick={() => choose()}><X size={14} /></button>}
    </div>
    {!open && current?.error && <p className="form-error" role="alert">{current.error} <button type="button" className="text-button" onClick={() => { setAttempt(n => n + 1); setOpen(true); input.current?.focus(); }}>Retry choices</button></p>}
    {missing && <p className="form-hint" role="status">The existing link is unavailable. Choose another record or clear it; your selection has not been changed.</p>}
    {open && <div ref={panel} className="record-picker-panel">
      {!!value && <p className="record-picker-selection">Selected: {selectedName}</p>}
      {!current && <p role="status">Searching…</p>}
      {current?.error && <div role="alert"><p>{current.error}</p>{current.authExpired && <a href={'/auth/sign-in?return_to='+encodeURIComponent(signInReturnTo)} target="_top">Sign in again</a>} <button type="button" className="text-button" onClick={() => setAttempt(n => n + 1)}>Retry choices</button></div>}
      <div ref={optionList} id={`${id}-choices`} role="listbox" aria-label={`${label} choices`} className="record-picker-options">
        <button type="button" role="option" id={`${id}-option-0`} aria-selected={!value} className={activeOption === 0 ? "active" : ""} disabled={!data || disabled}
          onMouseDown={e => e.preventDefault()} onClick={() => choose()}>{emptyLabel}</button>
        {choices.map((record, index) => <button type="button" role="option" id={`${id}-option-${index + 1}`} key={record.id}
          aria-selected={record.id === value} className={activeOption === index + 1 ? "active" : ""} disabled={disabled}
          onMouseDown={e => e.preventDefault()} onClick={() => choose(record)}>
          <span>{record.name}</span><small>{kindLabels[record.kind]}{record.detail ? ` · ${record.detail}` : ""}</small>
        </button>)}
      </div>
      {data && <div className="record-picker-pages">
        <span role="status">{data.total ? `${data.page * data.size + 1}–${Math.min((data.page + 1) * data.size, data.total)} of ${data.total}` : "No matching records"}</span>
        {data.total > data.size && <><button type="button" aria-label={`Previous ${label.toLowerCase()} choices`} disabled={!data.page || disabled} onClick={() => { setPage(data.page - 1); setActive(-1); }}>Previous</button>
          <button type="button" aria-label={`Next ${label.toLowerCase()} choices`} disabled={(data.page + 1) * data.size >= data.total || disabled} onClick={() => { setPage(data.page + 1); setActive(-1); }}>Next</button></>}
      </div>}
    </div>}
  </div>;
}
