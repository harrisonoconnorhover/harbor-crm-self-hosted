"use client";
import { Boxes, Target } from "lucide-react";
import { useEffect, useState } from "react";
import { ArrowUpRight, ContactRound, Building2, Handshake, ListTodo, Ticket } from "lucide-react";
import { kinds, type Kind } from "@/lib/crm";
import { portableSearchKinds, type PortableSearchCursor, type PortableSearchKind, type PortableSearchPage, type PortableSearchResult } from "@/lib/crm-search";

const labels = { "custom-objects": "Custom objects", contacts: "Contacts", companies: "Companies", deals: "Deals", tasks: "Tasks", tickets: "Tickets", leads: "Leads" };
const icons = { "custom-objects": Boxes, contacts: ContactRound, companies: Building2, deals: Handshake, tasks: ListTodo, tickets: Ticket, leads: Target };
type SearchPosition = { kind?: PortableSearchKind; page: number; cursor?:PortableSearchCursor };
type SearchProps = { query:string; match?:"words"|"phrase"; onMatchChange?:(match:"words"|"phrase")=>void; initialPosition?:SearchPosition; searchEndpoint?:string } & (
  { recordHref:(record:PortableSearchResult)=>string; onFollow:(position:SearchPosition)=>void; onNavigate?:never } |
  { recordHref?:never; onFollow?:never; onNavigate:(kind:Kind,id:string)=>void }
);
export function SearchResults({query,match,onMatchChange,onNavigate,onFollow,initialPosition,recordHref,searchEndpoint="/api/crm/search"}:SearchProps) {
  const [kind, setKind] = useState<PortableSearchKind | "">(initialPosition?.kind ?? "");
  const [position, setPosition] = useState({ query, kind, page: initialPosition?.page ?? 0, cursor:initialPosition?.cursor });
  const sameSearch=position.query===query&&position.kind===kind;
  const page=sameSearch?position.page:0;
  const cursor=sameSearch?position.cursor:undefined;
  const key = JSON.stringify({ query: query.trim(), kind: kind || undefined, match:match==="words"?match:undefined, page, cursor });
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ key: string; attempt: number; data?: PortableSearchPage; error?: string } | null>(null);
  useEffect(() => {
    if (!query.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(searchEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: controller.signal, cache: "no-store" });
        const data = await res.json() as PortableSearchPage & { error?: string };
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
  const keyed=Boolean(recordHref&&data?.start!==undefined);
  const start=data?(keyed?data.start:data.page*data.size):0;
  function navigate(page:number,cursor?:PortableSearchCursor|null){
    setPosition({query,kind,page,cursor:cursor??undefined});
  }
  return <section aria-label="CRM search results">
    <h3 className="search-section-heading">CRM records</h3>
    <div className="search-controls">
      <select aria-label="Search object" value={kind} onChange={e => setKind(e.target.value as PortableSearchKind | "")}>
        <option value="">All objects</option>
        {(recordHref ? portableSearchKinds : kinds).map(value => <option key={value} value={value}>{labels[value]}{data ? ` (${data.counts[value]})` : ""}</option>)}
      </select>
      {onMatchChange&&<select aria-label="Match records" value={match} onChange={e=>{navigate(0);onMatchChange(e.target.value==="words"?"words":"phrase");}}>
        <option value="phrase">Exact phrase</option><option value="words">All words</option>
      </select>}
      <span role="status">{data ? `${data.total} matching records` : current?.error ? "Search unavailable" : "Searching…"}</span>
    </div>
    {current?.error && <div className="search-empty" role="alert">{current.error} <button onClick={() => setAttempt(value => value + 1)}>Retry search</button></div>}
    {data?.results.map(record => {
      const Icon = icons[record.kind];
      const content = <><Icon size={20} /><span><b>{record.name}</b><small>{labels[record.kind]}{record.detail && ` · ${record.detail}`}</small></span><ArrowUpRight size={15} /></>;
      const position = {kind: kind || undefined, page: data.page,cursor};
      const resultKey = record.kind === "custom-objects" ? record.objectId + ":" + record.id : record.kind + ":" + record.id;
      return recordHref
        ? <a className="search-result" data-search-result key={resultKey} href={recordHref(record)} onClick={event => {
          if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) onFollow(position);
        }}>{content}</a>
        : record.kind === "custom-objects" ? null : <button className="search-result" data-search-result key={resultKey} onClick={()=>onNavigate(record.kind,record.id)}>{content}</button>;
    })}
    {data && !data.total && <p className="search-empty">No matching records.</p>}
    {data && cursor && !data.results.length && data.total>0 && <p className="search-empty">The matching records changed. <button onClick={()=>navigate(0)}>Show first results</button></p>}
    {data && data.results.length>0 && data.total > data.results.length && <nav className="search-controls" aria-label="Search result pages">
      <button disabled={keyed?!data.previous:!data.page} onClick={() => navigate(Math.max(0,data.page-1),data.previous)}>Previous results</button>
      <span>{start+1}–{start+data.results.length} of {data.total}</span>
      <button disabled={keyed?!data.next:(data.page+1)*data.size>=data.total} onClick={() => navigate(data.page+1,data.next)}>Next results</button>
    </nav>}
  </section>;
}
