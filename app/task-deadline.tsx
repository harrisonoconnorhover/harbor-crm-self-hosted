"use client";
import { useId } from "react";
import { scheduledInstants } from "@/lib/email/schedule";
import type { TaskDeadline } from "@/lib/task-deadline";
export function TaskDeadlineFields({ value, onChange, disabled = false, dateLabel = "Due date" }: {
  value: Partial<TaskDeadline>; onChange: (value: TaskDeadline) => void; disabled?: boolean; dateLabel?: string;
}) {
  const id = useId();
  const zone = value.dueTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const instants = value.dueDate && value.dueTime ? scheduledInstants(`${value.dueDate}T${value.dueTime}`, zone) : [];
  function change(patch: Partial<TaskDeadline>) {
    const next = { dueDate: "", ...value, ...patch };
    delete next.dueAt;
    if (!next.dueDate || !next.dueTime) { next.dueTime = ""; next.dueTimeZone = ""; next.dueTimeOccurrence = ""; }
    else { next.dueTimeZone ||= zone; if (!Object.hasOwn(patch, "dueTimeOccurrence")) next.dueTimeOccurrence = ""; }
    onChange(next);
  }
  return <div className="task-deadline-fields">
    <label className="form-field">{dateLabel}<input type="date" disabled={disabled} value={value.dueDate || ""} onInput={e => change({ dueDate: e.currentTarget.value })} onChange={e => change({ dueDate: e.target.value })} /></label>
    <label className="form-field">Due time<input type="time" disabled={disabled || !value.dueDate} value={value.dueTime || ""} onInput={e => change({ dueTime: e.currentTarget.value })} onChange={e => change({ dueTime: e.target.value })} /></label>
    {value.dueTime ? <>
      <label className="form-field">Time zone<input required list={id} value={zone} disabled={disabled} onChange={e => change({ dueTimeZone: e.target.value })} placeholder="America/New_York" /></label>
      <datalist id={id}>{Array.from(new Set([zone, "UTC", ...Intl.supportedValuesOf("timeZone")])).map(name => <option key={name} value={name} />)}</datalist>
      {instants.length > 1 && <label className="form-field">Clock-change occurrence<select required disabled={disabled} value={value.dueTimeOccurrence || ""} onChange={e => change({ dueTimeOccurrence: e.target.value as TaskDeadline["dueTimeOccurrence"] })}><option value="">Choose an occurrence</option><option value="earlier">Earlier ({instants[0].slice(11, 16)} UTC)</option><option value="later">Later ({instants[1].slice(11, 16)} UTC)</option></select></label>}
      {!instants.length && <small role="status">Check the time zone and time. Some local times do not exist when clocks move forward.</small>}
    </> : <small className="muted">Leave time blank for a date-only task.</small>}
  </div>;
}
