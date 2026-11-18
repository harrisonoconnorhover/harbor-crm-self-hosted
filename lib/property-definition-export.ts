import { z } from 'zod';
import { kinds, csvCell, type Kind } from './crm';
import type { FilterField } from './filters';
import type { Property } from './workspace';
import { isPipelineSettings, pipelineList, type DealStageSource } from './forecast';
import { ticketCatalog } from './ticket-pipelines';
import { recordLayoutFields } from './record-layout';
import { editableProperties } from './record-properties';
import { isDealRevenueField } from './deal-revenue';
import { normalizePropertyOrganization, propertyGroupCatalog, propertyGroupFor, type PropertyOrganization } from './property-groups';

export const definitionExportInput = z.object({
  selection: z.discriminatedUnion('scope', [
    z.object({ scope: z.literal('objects'), objects: z.array(z.enum(kinds)).min(1).max(5).refine(v => new Set(v).size === v.length, 'Choose each object once.') }),
    z.object({ scope: z.literal('selected'), kind: z.enum(kinds), fields: z.array(z.string().min(1).max(150)).min(1).max(2000).refine(v => new Set(v).size === v.length, 'Choose each property once.') }),
  ]),
  includeFillRates: z.boolean().default(true),
});
export type DefinitionExportInput = z.infer<typeof definitionExportInput>;
export type DefinitionOption = { value: string | boolean; label: string; pipelineId?: string; pipelineName?: string };
export type PropertyDefinition = { options: DefinitionOption[]; kind: Kind; field: FilterField; group: { id: string; name: string }; readOnly: boolean; storage: 'data' | 'createdAt' | 'updatedAt' | 'calculated' };
export type PropertyFill = { total: number; filled: number | null };
export function propertyDefinitions(kind: Kind, properties: Property[], pipelines: DealStageSource, organization: PropertyOrganization): PropertyDefinition[] {
  const fields = recordLayoutFields(kind, properties, pipelines), config = normalizePropertyOrganization(kind, fields, organization);
  const groups = new Map(propertyGroupCatalog(kind, fields, config).map(g => [g.id, g]));
  const editable = new Set(editableProperties(kind, properties, pipelines).map(f => f.id));
  return fields.map((field): PropertyDefinition => {
    let options: DefinitionOption[] = field.options?.map(value => ({ value, label: field.optionLabels?.[value] || value })) || [];
    if (field.type === 'checkbox') options = [{ value: true, label: 'Yes' }, { value: false, label: 'No' }];
    if (field.id === 'stage' && isPipelineSettings(pipelines)) options = pipelineList(pipelines).flatMap(p => p.stageOrder.map(value => ({ value, label: p.stageLabels?.[value] || value, pipelineId: p.id, pipelineName: p.name })));
    if (field.id === 'ticketStatus') options = ticketCatalog(pipelines).pipelines.flatMap(p => p.stages.map(s => ({ value: s.id, label: s.label, pipelineId: p.id, pipelineName: p.name })));
    return { kind, field, options, group: groups.get(propertyGroupFor(kind, field, config))!, readOnly: !editable.has(field.id),
    storage: field.id === 'createdAt' || field.id === 'updatedAt' ? field.id : editable.has(field.id) || isDealRevenueField(field.id) || field.id === 'closedAt' ? 'data' : 'calculated',
  }; }).sort((a, b) => a.field.label.localeCompare(b.field.label) || a.field.id.localeCompare(b.field.id));
}
export function definitionExportHeader(includeFillRates: boolean) {
  return ['Object', 'Property name', 'Internal name', 'Property origin', 'Field type', 'Group name', 'Group ID', 'Description', 'Options (JSON)', 'Read-only value',
    ...(includeFillRates ? ['Records checked (all current records of object)', 'Records with a value', 'Fill rate (%)', 'Fill rate status'] : []), 'Validation rules (JSON)', 'Unique values', 'Default link text', 'Allow custom link text','Show relative time'].map(csvCell).join(',') + '\r\n';
}
export function definitionExportRow(def: PropertyDefinition, includeFillRates: boolean, fill?: PropertyFill) {
  const { field } = def;
  const cells: unknown[] = [def.kind, field.label, field.id, field.id.startsWith('custom:') ? 'Custom' : 'Standard', field.type === 'text' && field.multiline ? 'textarea' : field.type, def.group.name, def.group.id, field.description || '', JSON.stringify(def.options), def.readOnly ? 'Yes' : 'No'];
  if (includeFillRates) {
    if (!fill) throw Error('Missing property fill-rate result.');
    cells.push(fill.total, fill.filled ?? '', fill.filled === null || fill.total === 0 ? '' : Math.round(fill.filled / fill.total * 10000) / 100,
      fill.filled === null ? 'Not measured: calculated at read time' : fill.total === 0 ? 'No records' : 'Measured');
  }
  cells.push(field.validation ? JSON.stringify(field.validation) : '', field.uniqueValues ? 'Yes' : 'No',field.type==='url'?field.linkText||'':'',field.type==='url'?(field.allowCustomLinkText?'Yes':'No'):'',['date','datetime'].includes(field.type)?(field.showRelativeTime?'Yes':'No'):'');
  return cells.map(csvCell).join(',') + '\r\n';
}
