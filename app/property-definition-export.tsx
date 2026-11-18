'use client';
import { useState } from 'react';
import { kinds, type Kind } from '@/lib/crm';
import type { FilterField } from '@/lib/filters';
import type { DefinitionExportInput } from '@/lib/property-definition-export';
import { Dialog } from './workspace-tools';

export function PropertyDefinitionExport({ kind, selected, onClose }: { kind: Kind; selected: FilterField[] | null; onClose: () => void }) {
  const [objects, setObjects] = useState<Kind[]>([kind]), [fillRates, setFillRates] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [downloaded, setDownloaded] = useState<number | null>(null);
  async function download() {
    setBusy(true); setError(''); setDownloaded(null);
    const selection: DefinitionExportInput['selection'] = selected ? { scope: 'selected', kind, fields: selected.map(f => f.id) } : { scope: 'objects', objects };
    try {
      const response = await fetch('/api/property-definitions-export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection, includeFillRates: fillRates }) });
      if (!response.ok) { const data = await response.json() as { error?: string }; throw Error(data.error || 'Could not export definitions.'); }
      const file = await response.blob(), url = URL.createObjectURL(file), link = document.createElement('a');
      link.href = url; link.download = 'harbor-property-definitions.csv'; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setDownloaded(Number(response.headers.get('X-Property-Count')));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not download definitions.'); }
    finally { setBusy(false); }
  }
  return <Dialog title="Export property definitions" busy={busy} onClose={onClose}><div className="tool-body">
    <p>Download a CSV data dictionary with property names, internal IDs, types, groups, descriptions, options and read-only status.</p>
    {selected ? <section className="definition-export-selection"><h3>{selected.length} selected {selected.length === 1 ? 'property' : 'properties'} · {kind}</h3><ul>{selected.map(f => <li key={f.id}>{f.label}</li>)}</ul></section> : <fieldset className="definition-export-objects"><legend>Objects to export</legend>{kinds.map(k => <label key={k}><input type="checkbox" disabled={busy} checked={objects.includes(k)} onChange={e => { setObjects(e.target.checked ? kinds.filter(object => object === k || objects.includes(object)) : objects.filter(object => object !== k)); setDownloaded(null); }} />{k[0].toUpperCase() + k.slice(1)}</label>)}</fieldset>}
    {!selected && <p className="muted">Includes every current standard and custom property for the chosen objects, regardless of library search or filters.</p>}
    <label className="history-export-source"><input type="checkbox" checked={fillRates} disabled={busy} onChange={e => { setFillRates(e.target.checked); setDownloaded(null); }} /> Include record counts and fill rates</label>
    {fillRates && <p className="muted">Checks all current records in your private workspace, including off-page records. Counts follow “is known” filters: zero and No count as filled; empty values do not. Calculations made only when reading a record are marked unmeasured. Deleted records are excluded. Counts reflect each object when it is read.</p>}
    <p className="muted">This exports definitions and counts, not record values. Formula-like text is escaped for spreadsheets. Options include internal values and labels as JSON, with pipeline IDs/names for stages and ticket statuses. Usage in workflows/reports, creator details and definition-change history are not included.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {downloaded !== null && <p role="status">Download prepared: {downloaded} property definitions.</p>}
    <div className="tool-actions"><button className="secondary" disabled={busy} onClick={onClose}>Back</button><button className="primary" disabled={busy || (!selected && !objects.length)} onClick={download}>{busy ? 'Preparing CSV…' : 'Download definitions CSV'}</button></div>
  </div></Dialog>;
}
