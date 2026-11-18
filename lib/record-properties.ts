import {isTicketSlaField} from './ticket-sla-properties';
import {moveLeadPipeline} from './lead-pipelines';
import {urlEditSchema,propertyURLSchema} from "./property-links";
import { taskDeadlineSchema, taskDeadlineValue } from "./task-deadline";
import {isRecordSourceField} from './record-source';
import {isCurrentStageField} from './current-stage';
import { isDealRevenueField, retainDealRevenue } from "./deal-revenue";
import { moveTicketPipeline } from "./ticket-pipelines";
import { samePropertyValue } from "./property-values";
import { type DealStageSource, movePipeline } from "./forecast";
import { stages, type CRMRecord, type Data, type Kind } from "./crm";
import { filterFields } from "./filters";
import { InputError, parseRecord, type Property } from "./workspace";

export function editableProperties(
  kind: Kind,
  properties: Property[],
  dealStages: DealStageSource = stages,
) {
  return filterFields(kind, properties, dealStages).filter(
    (f) =>
      !isRecordSourceField(f.id) && !isDealRevenueField(f.id) && !isCurrentStageField(f.id) && !isTicketSlaField(f.id) && ![
        "closedAt", "timeToCloseHours",
        "createdAt",
        "updatedAt",
        "lastContacted",
        "lastActivity",
        "company",
        "contact",
        "related",
      ].includes(f.id),
  );
}
export function propertyValue(data: Data, field: string): unknown {
  if (field.startsWith("linkText:")) return data.customLinkText?.[field.slice(9)]?.text ?? null;
  if (field === "taskDeadline") return taskDeadlineValue(data);
  if(field==='leadPipelineId')return data.leadPipelineId||'default';
  if (field === "ticketPipelineId") return data.ticketPipelineId || "default";
  if (field === "pipelineId") return data.pipelineId || "default";
  if (field === "taskType") return data.taskType || "To-do";
  return field.startsWith("custom:")
    ? (data.custom?.[field.slice(7)] ?? null)
    : (data[field as keyof Data] ?? null);
}
export function patchProperty(
  record: CRMRecord,
  field: string,
  value: unknown,
  properties: Property[],
  dealStages: DealStageSource = stages,
) {
  if (!(record.kind === "tasks" && field === "taskDeadline") && !editableProperties(record.kind, properties, dealStages).some((f) => f.id === field))
    throw new InputError("Choose an editable property.");
  if(field.startsWith('custom:')&&value&&typeof value==='object'&&!Array.isArray(value)){
    const p=properties.find(p=>p.id===field.slice(7)&&p.kind===record.kind&&!p.archivedAt);
    if(p?.type==='url'){
      if(!p.allowCustomLinkText)throw new InputError('Custom link text is disabled for this property. Refresh the record.');
      const edit=urlEditSchema.parse(value),url=edit.url===''?'':propertyURLSchema.parse(edit.url);
      if(!url&&edit.linkText)throw new InputError('Enter a URL before adding link text.');
      return retainDealRevenue(parseRecord(record.kind,{...record.data,custom:{...record.data.custom,[p.id]:url},customLinkText:{...record.data.customLinkText,[p.id]:edit.linkText?{url,text:edit.linkText}:null}},properties,dealStages,record.data),record.data);
    }
  }
  return retainDealRevenue(parseRecord(
    record.kind,
    record.kind === "tasks" && field === "taskDeadline" ? { ...record.data, ...taskDeadlineValue(taskDeadlineSchema.parse(value)) }
      : record.kind === "tasks" && field === "dueDate" && !value ? { ...record.data, dueDate: "", dueTime: "", dueTimeZone: "", dueTimeOccurrence: "" }
      : field.startsWith("custom:")
      ? {
          ...record.data,
          custom: { ...record.data.custom, [field.slice(7)]: value },
        }
      : field === "leadPipelineId" ? moveLeadPipeline(record.data,String(value),dealStages) : field === "ticketPipelineId" ? moveTicketPipeline(record.data,String(value),dealStages) : field === "pipelineId"
        ? movePipeline(record.data, String(value), dealStages)
        : { ...record.data, [field]: value },
    properties,
    dealStages,
    record.data,
  ), record.data);
}
export type PropertyChange = { field: string; before: unknown; after: unknown };
export function propertyChanges(before: Data, after: Data): PropertyChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("custom");
  keys.delete("customLinkText");
  for(const id of new Set([...Object.keys(before.customLinkText||{}),...Object.keys(after.customLinkText||{})]))keys.add("linkText:"+id);
  keys.delete("sample");
  const custom = new Set([
    ...Object.keys(before.custom ?? {}),
    ...Object.keys(after.custom ?? {}),
  ]);
  for (const key of custom) keys.add("custom:" + key);
  return [...keys]
    .map((field) => ({
      field,
      before: propertyValue(before, field),
      after: propertyValue(after, field),
    }))
    .filter((c) => !samePropertyValue(c.before, c.after));
}
export type HistoryEntry = {
  id: string;
  recordId: string;
  before: Data;
  after: Data;
  source: string;
  createdAt: string;
};
