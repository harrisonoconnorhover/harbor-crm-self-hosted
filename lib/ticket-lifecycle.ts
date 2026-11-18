import { ticketStageFor } from "./ticket-pipelines";
import type { DealStageSource } from "./forecast";
import type { Data } from "./crm";

// Every ticket creation/status write uses this rule; callers cannot set the clock.
export function ticketLifecycle(data: Data, before: Data | undefined, now: string, source?: DealStageSource): Data {
  if (data.ticketStatus === undefined) return data;
  const status = ticketStageFor(source, data);
  if (!status) throw new Error("Ticket status is unavailable. Refresh the ticket pipeline settings.");
  return { ...data, closedAt: status.outcome !== "closed" ? null
    : before && ticketStageFor(source, before)?.outcome === "closed" ? before.closedAt || now : now };
}
