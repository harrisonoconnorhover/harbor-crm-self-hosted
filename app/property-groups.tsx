'use client';
import {validationSummary} from '@/lib/property-validation';
import {propertyTypeLabel} from '@/lib/property-text';
import { useEffect, useState, type ReactNode } from 'react';
import type { Kind } from '@/lib/crm';
import type { FilterField } from '@/lib/filters';
import { normalizePropertyOrganization, propertyGroupCatalog, propertyGroupFor, type PropertyGroupInput, type PropertyGroupState } from '@/lib/property-groups';

export function PropertyOrganization({ kind, fields, disabled, actions, editableIds, onExport }: {
  onExport?: (fields: FilterField[] | null) => void;
  kind: Kind; fields: FilterField[]; editableIds: string[]; disabled: boolean; actions: (field: FilterField) => ReactNode;
}) {
  const [state, setState] = useState<PropertyGroupState | null>(null);
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [message, setMessage] = useState('');
  const [tab, setTab] = useState<'properties' | 'groups'>('properties');
  const [query, setQuery] = useState(''), [group, setGroup] = useState(''), [type, setType] = useState('');
  const [selected, setSelected] = useState<string[]>([]), [target, setTarget] = useState('');
  const [newGroupId, setNewGroupId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(''), [editing, setEditing] = useState<string | null>(null), [deleting, setDeleting] = useState<string | null>(null);
  async function load() {
    setError('');
    try { const r = await fetch('/api/property-groups?kind=' + kind, { cache: 'no-store' }), data = await r.json() as PropertyGroupState & { error?: string }; if (!r.ok) throw Error(data.error); setState(data); setSelected([]); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { let active = true; setState(null); setError('');
    fetch('/api/property-groups?kind=' + kind, { cache: 'no-store' }).then(async r => { const data = await r.json() as PropertyGroupState & { error?: string }; if (!r.ok) throw Error(data.error); if (active) setState(data); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [kind]);
  const config = normalizePropertyOrganization(kind, fields, state || { groups: [], assignments: {} });
  const groups = propertyGroupCatalog(kind, fields, config);
  const defaultNames = new Set(groups.filter(g => g.builtin).map(g => g.name.toLocaleLowerCase()));
  const groupLabel = (g: typeof groups[number]) => !g.builtin && defaultNames.has(g.name.toLocaleLowerCase())
    ? g.name + ' (custom group)' : g.name;
  const validSelection = selected.filter(id => fields.some(f => f.id === id));
  const visible = fields.filter(f => (!group || propertyGroupFor(kind, f, config) === group) && (!type || (type === 'custom' ? f.id.startsWith('custom:') : type === 'standard' ? !f.id.startsWith('custom:') : (f.type==='text' && f.multiline ? 'textarea' : f.type) === type)) && `${f.label} ${f.id} ${f.description || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const busy = saving || disabled;
  const locked = busy || !state;
  async function change(change: PropertyGroupInput['change'], success: string) {
    if (!state || locked) return false;
    setSaving(true); setError(''); setMessage('');
    try {
      const r = await fetch('/api/property-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, revision: state.revision, change }) });
      const data = await r.json() as PropertyGroupState & { error?: string }; if (!r.ok) throw Error(data.error);
      setState(data); setMessage(success); return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { setSaving(false); }
  }
  function resetSelection() { setSelected([]); setMessage(''); }
  return <section className="property-organization" aria-label="Property organization">
    {onExport && <div className="property-definition-export-action"><button className="secondary" disabled={busy} onClick={() => onExport(null)}>Export all definitions</button></div>}
    <div className="property-organization-tabs" role="tablist" aria-label="Property settings">
      <button role="tab" aria-selected={tab === 'properties'} onClick={() => setTab('properties')}>Properties ({fields.length})</button>
      <button role="tab" aria-selected={tab === 'groups'} onClick={() => setTab('groups')}>Groups ({groups.length})</button>
    </div>
    {error && <div className="form-error" role="alert">{error} <button className="text-button" disabled={busy} onClick={load}>Reload groups</button></div>}
    <p className="sr-only" role="status">{message}</p>
    {!state && !error && <p className="muted">Loading property groups…</p>}
    {tab === 'properties' ? <>
      <div className="property-organization-filters">
        <label>Search properties<input type="search" value={query} onChange={e => { setQuery(e.target.value); resetSelection(); }} placeholder="Name or internal name" /></label>
        <label>Property group<select aria-label="Filter property group" value={group} onChange={e => { setGroup(e.target.value); resetSelection(); }}><option value="">All groups</option>{groups.map(g => <option key={g.id} value={g.id}>{groupLabel(g)}</option>)}</select></label>
        <label>Property type<select aria-label="Filter property type" value={type} onChange={e => { setType(e.target.value); resetSelection(); }}><option value="">All types</option><option value="standard">Standard properties</option><option value="custom">Custom properties</option>{['text', 'textarea', 'url', 'email', 'number', 'date', 'datetime', 'select', 'checkbox', 'multiselect'].map(t => <option key={t} value={t}>{propertyTypeLabel(t)}</option>)}</select></label>
      </div>
      <div className="property-group-bulk">
        <label><input type="checkbox" aria-label="Select all matching properties" disabled={locked || !visible.length} checked={visible.length > 0 && visible.every(f => validSelection.includes(f.id))} onChange={e => setSelected(e.target.checked ? visible.map(f => f.id) : [])} /> {validSelection.length ? `${validSelection.length} selected` : `${visible.length} ${visible.length === 1 ? 'property' : 'properties'}`}</label>
        {!!validSelection.length && <><select aria-label="Move selected properties to group" disabled={locked} value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose a group</option>{groups.map(g => <option key={g.id} value={g.id}>{groupLabel(g)}</option>)}</select><button className="secondary" disabled={locked || !target} onClick={async () => { if (await change({ action: 'move', fields: validSelection, group: target }, `${validSelection.length} ${validSelection.length === 1 ? 'property' : 'properties'} moved`)) setSelected([]); }}>Move to group</button>{onExport && <button className="secondary" disabled={busy} onClick={() => onExport(fields.filter(f => validSelection.includes(f.id)))}>Export selected definitions</button>}<button className="text-button" onClick={() => setSelected([])}>Clear</button></>}
      </div>
      <div className="property-list organized-property-list">
        {visible.map(f => <div key={f.id}>
          <input type="checkbox" aria-label={`Select ${f.label}`} disabled={locked} checked={validSelection.includes(f.id)} onChange={e => setSelected(e.target.checked ? [...validSelection, f.id] : validSelection.filter(id => id !== f.id))} />
          <span><b>{f.label}</b><small>{f.id} · {propertyTypeLabel(f.type==='text'&&f.multiline?'textarea':f.type)} · {f.id.startsWith('custom:') ? 'Custom' : 'Standard'}{!editableIds.includes(f.id) ? ' · Read-only value' : ''}{f.uniqueValues ? ' · Unique values' : ''}</small><small>{groups.filter(g => g.id === propertyGroupFor(kind, f, config)).map(groupLabel)}</small>{f.description && <small>{f.description}</small>}{f.validation && <small>{validationSummary(f.validation)}</small>}{!!f.options?.length && <small>{f.options.map(o => f.optionLabels?.[o] ?? o).join(', ')}</small>}</span>
          <div className="property-row-actions">{actions(f)}</div>
        </div>)}
        {!visible.length && <p className="muted">No matching properties.</p>}
      </div>
    </> : <>
      <p className="form-intro">Groups organize properties in settings. Customize a record’s sidebar separately with Customize properties.</p>
      <form className="property-group-form" onSubmit={async e => {
        e.preventDefault(); const ok = await change(editing ? { action: 'rename', id: editing, name: name.trim() } : { action: 'create', id: newGroupId, name: name.trim() }, editing ? 'Group renamed' : 'Group created');
        if (ok) { setName(''); setEditing(null); setNewGroupId(crypto.randomUUID()); }
      }}>
        <label>{editing ? 'Rename group' : 'New group name'}<input value={name} maxLength={80} required disabled={locked} onChange={e => setName(e.target.value)} /></label>
        <button className="primary" disabled={locked || !name.trim()}>{editing ? 'Save group name' : 'Create group'}</button>
        {editing && <button type="button" className="text-button" onClick={() => { setEditing(null); setName(''); }}>Cancel rename</button>}
      </form>
      <div className="property-list property-group-list">{groups.map(g => {
        const count = fields.filter(f => propertyGroupFor(kind, f, config) === g.id).length;
        return <div key={g.id}><span><b>{groupLabel(g)}</b><small>{count} {count === 1 ? 'property' : 'properties'}{g.builtin ? ' · Default group' : ''}</small></span>
          <button className="text-button" onClick={() => { setGroup(g.id); setQuery(''); setType(''); resetSelection(); setTab('properties'); }}>View properties</button>
          {!g.builtin && <><button className="text-button" disabled={locked} aria-label={`Rename ${g.name}`} onClick={() => { setEditing(g.id); setName(g.name); setDeleting(null); }}>Rename</button>
            {deleting === g.id ? <><span className="muted">Delete empty group?</span><button className="text-button danger" disabled={locked || count > 0} onClick={async () => { if (await change({ action: 'delete', id: g.id }, 'Group deleted')) { setDeleting(null); if (group === g.id) setGroup(''); if (target === g.id) setTarget(''); if (editing === g.id) { setEditing(null); setName(''); } } }}>Confirm delete</button><button className="text-button" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button></> : <button className="text-button danger" disabled={locked || count > 0} title={count ? 'Move properties out of this group before deleting it.' : 'Delete this empty group'} aria-label={`Delete ${g.name}`} onClick={() => setDeleting(g.id)}>Delete</button>}</>}
        </div>;
      })}</div>
    </>}
    {!!message && <p className="form-intro">{message}</p>}
  </section>;
}
