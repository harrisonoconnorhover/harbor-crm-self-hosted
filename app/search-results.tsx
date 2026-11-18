"use client";
import { Target } from "lucide-react";
import { useEffect, useState } from "react";
import { ArrowUpRight, ContactRound, Building2, Handshake, ListTodo, Ticket } from "lucide-react";
import { kinds, type Kind } from "@/lib/crm";
import type { SearchPage } from "@/lib/crm-search";

const labels = { contacts: "Contacts", companies: "Companies", deals: "Deals", tasks: "Tasks", tickets: "Tickets", leads: "Leads" };
const icons = { contacts: ContactRound, companies: Building2, deals: Handshake, tasks: ListTodo, tickets: Ticket, leads: Target };
type SearchPosition = { kind?: Kind; page: number };
export function SearchResults({ query, onNavigate, initialPosition, recordHref, searchEndpoint = "/api/crm/search" }: {
  query: string;
  onNavigate: (kind: Kind, id: string, position: SearchPosition) => void;
  initialPosition?: SearchPosition;
  recordHref?: (kind: Kind, id: string) => string;
  searchEndpoint?: string;
}) {
  const [kind, setKind] = useState<Kind | "">(initialPosition?.kind ?? "");
  const [position, setPosition] = useState({ query, kind, page: initialPosition?.page ?? 0 });
  const page = position.query === query && position.kind === kind ? position.page : 0;
  const key = JSON.stringify({ query: query.trim(), kind: kind || undefined, page });
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ key: string; attempt: number; data?: SearchPage; error?: string } | null>(null);
  useEffect(() => {
    if (!query.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(searchEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: controller.signal, cache: "no-store" });
        const data = await res.json() as SearchPage & { error?: string };
        if (!res.ok) throw new Error(data.error || "Could not search records.");
        if (!controller.signal.aborted) setResponse({ key, attempt, data });
      } catch (error) {
        if (!controller.signal.aborted) setResponse({ key, attempt, error: error instanceof Error ? error.message : "Could not search records." });
      }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, attempt, query, searchEndpoint]);
  if (!query.trim()) return null;
  const current = response?.key === key && response.attempt === attempt ? response : null;
  const data = current?.data;
  return <section aria-label="CRM search results">
    <h3 className="search-section-heading">CRM records</h3>
    <div className="search-controls">
      <select aria-label="Search object" value={kind} onChange={e => setKind(e.target.value as Kind | "")}>
        <option value="">All objects</option>
        {kinds.map(value => <option key={value} value={value}>{labels[value]}{data ? ` (${data.counts[value]})` : ""}</option>)}
      </select>
      <span role="status">{data ? `${data.total} matching records` : current?.error ? "Search unavailable" : "Searching…"}</span>
    </div>
    {current?.error && <div className="search-empty" role="alert">{current.error} <button onClick={() => setAttempt(value => value + 1)}>Retry search</button></div>}
    {data?.results.map(record => {
      const Icon = icons[record.kind];
      const content = <><Icon size={20} /><span><b>{record.name}</b><small>{labels[record.kind]}{record.detail && ` · ${record.detail}`}</small></span><ArrowUpRight size={15} /></>;
      const select = () => onNavigate(record.kind, record.id, { kind: kind || undefined, page: data.page });
      const resultKey = record.kind + ":" + record.id;
      return recordHref
        ? <a className="search-result" data-search-result key={resultKey} href={recordHref(record.kind, record.id)} onClick={event => {
          if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) select();
        }}>{content}</a>
        : <button className="search-result" data-search-result key={resultKey} onClick={select}>{content}</button>;
    })}
    {data && !data.total && <p className="search-empty">No matching records.</p>}
    {data && data.total > data.size && <nav className="search-controls" aria-label="Search result pages">
      <button disabled={!data.page} onClick={() => setPosition({ query, kind, page: data.page - 1 })}>Previous results</button>
      <span>{data.page * data.size + 1}–{Math.min((data.page + 1) * data.size, data.total)} of {data.total}</span>
      <button disabled={(data.page + 1) * data.size >= data.total} onClick={() => setPosition({ query, kind, page: data.page + 1 })}>Next results</button>
    </nav>}
  </section>;
}
