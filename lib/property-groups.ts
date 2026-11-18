import { z } from 'zod';
import { kinds, type Kind } from './crm';
import type { FilterField } from './filters';

export type PropertyGroup = { id: string; name: string };
export type PropertyOrganization = { groups: PropertyGroup[]; assignments: Record<string, string> };
export type PropertyGroupState = PropertyOrganization & { kind: Kind; revision: number };
const name = z.string().trim().min(1).max(80).transform(value => value.normalize('NFC'));
const groupId = z.string().min(1).max(150);
export const propertyGroupInput = z.object({
  kind: z.enum(kinds), revision: z.number().int().min(0),
  change: z.discriminatedUnion('action', [
    z.object({ action: z.literal('create'), id: z.string().guid("Invalid uuid"), name }),
    z.object({ action: z.literal('rename'), id: groupId, name }),
    z.object({ action: z.literal('delete'), id: groupId }),
    z.object({ action: z.literal('move'), group: groupId, fields: z.array(z.string().min(1).max(150)).min(1).max(2000) }),
  ]),
});
export type PropertyGroupInput = z.infer<typeof propertyGroupInput>;
const objectNames: Record<Kind, string> = { contacts: 'Contact', companies: 'Company', deals: 'Deal', tasks: 'Task', tickets: 'Ticket', leads: 'Lead' };
// Stable IDs are separate from display labels; keep IDs when changing catalog copy.
const defaultGroupIds: Record<string, string> = {
  'Forecasting': 'forecasting', 'Lead information': 'lead_information',
  'Record information': 'record_information',
  'Contact information': 'contact_information', 'Company information': 'company_information',
  'Deal information': 'deal_information', 'Task information': 'task_information', 'Ticket information': 'ticket_information',
  'Address': 'address', 'Professional information': 'professional_information', 'Qualification': 'qualification',
  'Company profile': 'company_profile', 'Deal outcome': 'deal_outcome', 'Task details': 'task_details',
};
export function defaultPropertyGroup(kind: Kind, field: FilterField): PropertyGroup {
  if (field.id.startsWith('custom:')) return { id: 'default:custom', name: 'Custom properties' };
  const label = field.group || `${objectNames[kind]} information`;
  const id = defaultGroupIds[label];
  if (!id) throw Error(`Missing stable property-group ID for ${label}`);
  return { id: 'default:' + id, name: label };
}
export function propertyGroupCatalog(kind: Kind, fields: FilterField[], config: PropertyOrganization) {
  const defaults = new Map(fields.map(f => { const g = defaultPropertyGroup(kind, f); return [g.id, { ...g, builtin: true }]; }));
  // Keep the fallback group available before the first custom property is created.
  defaults.set('default:custom', { id: 'default:custom', name: 'Custom properties', builtin: true });
  return [...defaults.values(), ...config.groups.map(g => ({ ...g, builtin: false }))].sort((a, b) => a.name.localeCompare(b.name));
}
export function propertyGroupFor(kind: Kind, field: FilterField, config: PropertyOrganization) {
  return config.assignments[field.id] || defaultPropertyGroup(kind, field).id;
}
export function normalizePropertyOrganization(kind: Kind, fields: FilterField[], config: PropertyOrganization): PropertyOrganization {
  const groups = propertyGroupCatalog(kind, fields, config), available = new Set(groups.map(g => g.id));
  const assignments = Object.fromEntries(fields.flatMap(f => {
    const id = config.assignments[f.id];
    return id && available.has(id) && id !== defaultPropertyGroup(kind, f).id ? [[f.id, id]] : [];
  }).sort(([a], [b]) => a.localeCompare(b)));
  return { groups: config.groups, assignments };
}
export function changePropertyOrganization(current: PropertyGroupState, fields: FilterField[], change: PropertyGroupInput['change']): PropertyOrganization {
  const config = normalizePropertyOrganization(current.kind, fields, current);
  const catalog = propertyGroupCatalog(current.kind, fields, config);
  if (change.action === 'create' || change.action === 'rename') {
    const existing = catalog.find(g => g.id === change.id);
    if (change.action === 'create' && existing && !existing.builtin && existing.name === change.name) return config;
    if (catalog.some(g => g.id !== change.id && g.name.toLocaleLowerCase() === change.name.toLocaleLowerCase())) throw Error('A group with that name already exists.');
    if (change.action === 'create') {
      if (existing) throw Error('That group already exists. Reload groups.');
      if (config.groups.length >= 100) throw Error('Use up to 100 custom groups per object.');
      config.groups = [...config.groups, { id: change.id, name: change.name }];
    } else {
      if (!existing) throw Error('This group is no longer available.');
      if (existing.builtin) throw Error('Default groups cannot be renamed.');
      config.groups = config.groups.map(g => g.id === change.id ? { ...g, name: change.name } : g);
    }
  } else if (change.action === 'delete') {
    const group = catalog.find(g => g.id === change.id);
    if (group?.builtin) throw Error('Default groups cannot be deleted.');
    if (fields.some(f => propertyGroupFor(current.kind, f, config) === change.id)) throw Error('Move the properties to another group before deleting this group.');
    config.groups = config.groups.filter(g => g.id !== change.id);
  } else {
    if (!catalog.some(g => g.id === change.group)) throw Error('Choose an available group.');
    const ids = new Set(fields.map(f => f.id));
    if (new Set(change.fields).size !== change.fields.length || change.fields.some(id => !ids.has(id))) throw Error('Choose available properties from this object only.');
    for (const id of change.fields) config.assignments[id] = change.group;
  }
  return normalizePropertyOrganization(current.kind, fields, config);
}
