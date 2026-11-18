import { z } from "zod";
import { scheduledInstants, validTimeZone } from "./email/schedule";

export const taskTimeFields = {
  dueTime: z.string().regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/, "Use a time from 00:00 to 23:59.").optional(),
  dueTimeZone: z.string().max(100).refine(value => !value || validTimeZone(value), "Choose a valid time zone.").optional(),
  dueTimeOccurrence: z.enum(["", "earlier", "later"]).optional(),
};
export const taskDeadlineSchema = z.object({
  dueDate: z.union([z.literal(""), z.string().date("Use a valid due date.")]), ...taskTimeFields,
}).strict();
export type TaskDeadline = z.infer<typeof taskDeadlineSchema> & { dueAt?: string };
export function taskDeadlineValue(data: Partial<TaskDeadline>): Required<Omit<TaskDeadline, "dueAt">> {
  return { dueDate: data.dueDate || "", dueTime: data.dueTime || "", dueTimeZone: data.dueTimeZone || "", dueTimeOccurrence: data.dueTimeOccurrence || "" };
}
function invalid(message: string): never { throw new z.ZodError([{ code: "custom", path: ["dueTime"], message }]); }
// All timed deadlines are normalized on the server. dueAt is derived and is
// never trusted from a form, import, workflow, or integration.
export function normalizeTaskDeadline<T extends Partial<TaskDeadline>>(input: T): T & TaskDeadline {
  const result = { ...input } as T & TaskDeadline;
  delete result.dueAt;
  if (!result.dueTime) {
    delete result.dueTime; delete result.dueTimeZone; delete result.dueTimeOccurrence;
    return result;
  }
  if (!result.dueDate) invalid("Choose a due date before adding a time.");
  if (!result.dueTimeZone) invalid("Choose a time zone for the task deadline.");
  const instants = scheduledInstants(`${result.dueDate}T${result.dueTime}`, result.dueTimeZone);
  if (!instants.length) invalid("That local time does not exist because the clocks move forward. Choose another time.");
  if (instants.length > 1 && !result.dueTimeOccurrence) invalid("That time occurs twice when the clocks move back. Choose the earlier or later occurrence.");
  result.dueAt = instants[result.dueTimeOccurrence === "later" ? instants.length - 1 : 0];
  if (instants.length === 1) delete result.dueTimeOccurrence;
  return result;
}
export function taskDeadlineLabel(data: Partial<TaskDeadline>) {
  if (!data.dueDate) return "No due date";
  const day = new Date(data.dueDate + "T12:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  if (!data.dueTime) return day;
  return `${day} · ${data.dueTime} ${data.dueTimeZone || ""}${data.dueTimeOccurrence ? ` (${data.dueTimeOccurrence})` : ""}`;
}
// Timed tasks sort by their actual instant. Date-only tasks retain a calendar
// date sort key at the end of that UTC date; this key is not an expiry time.
export function taskDeadlineSort(data: Partial<TaskDeadline>) {
  return data.dueDate ? data.dueAt || `${data.dueDate}T23:59:59.999Z` : "";
}

export const isTaskDeadlineField = (kind: string, field: string) => kind === "tasks" && ["dueDate", "dueTime", "dueTimeZone", "dueTimeOccurrence"].includes(field);
