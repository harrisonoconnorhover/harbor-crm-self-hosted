import { z } from "zod";
import { localDateTime, scheduledInstants } from "./email/schedule";

// Require an explicit offset at API/import boundaries; persist one sortable UTC
// representation. Milliseconds are the storage precision, never silently truncate.
export const propertyDateTimeSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
  "Use an ISO date and time with seconds and a time zone, such as 2026-10-29T14:30:00-04:00.",
).datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), "Choose a valid date and time.")
  .transform(value => new Date(value).toISOString());

export function dateTimeLocalValue(value: string, zone: string) {
  const parsed = propertyDateTimeSchema.safeParse(value);
  if (!parsed.success) return value;
  const date = new Date(parsed.data);
  return localDateTime(date, zone) + ":" + String(date.getUTCSeconds()).padStart(2, "0") + "." + String(date.getUTCMilliseconds()).padStart(3, "0");
}
export function dateTimeLocalInstants(local: string, zone: string) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/.exec(local);
  if (!match) return [];
  const millis = Number(match[2] || 0) * 1000 + Number((match[3] || "").padEnd(3, "0"));
  return scheduledInstants(match[1], zone).map(at => new Date(Date.parse(at) + millis).toISOString());
}
export function displayDateTime(value: unknown) {
  if (!value) return "—";
  const parsed = propertyDateTimeSchema.safeParse(value);
  return parsed.success ? new Date(parsed.data).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" }) : "—";
}
