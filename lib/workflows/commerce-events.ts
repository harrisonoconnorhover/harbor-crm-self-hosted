import { z } from "zod";
export const commerceEvents = ["quote_accepted", "quote_declined", "invoice_paid", "invoice_overdue"] as const;
export const commerceTriggerSchema = z.object({ event: z.enum(commerceEvents) });
export type CommerceEventName = typeof commerceEvents[number];
export const commerceEventLabels: Record<CommerceEventName, string> = {
  quote_accepted: "Quote accepted", quote_declined: "Quote declined",
  invoice_paid: "Invoice paid in full", invoice_overdue: "Invoice becomes overdue",
};
export type CommercePayload = {
  event: CommerceEventName; documentType: "quote" | "invoice"; documentId: string;
  label: string; totalUsd: number; balanceUsd?: number; acceptedOn?: string;
  paidOn?: string; dueOn?: string; sample?: boolean;
};
export type CommerceEvent = { id: string; epoch: string; detectedAt: string; payload: CommercePayload };
export function sampleCommercePayload(event: CommerceEventName): CommercePayload {
  return { event, documentType: event.startsWith("quote") ? "quote" : "invoice",
    documentId: "00000000-0000-4000-8000-000000000001", label: "Sample document (test only)",
    totalUsd: 100, ...(event.startsWith("invoice") ? { balanceUsd: event === "invoice_paid" ? 0 : 100, dueOn: "2026-01-15" } : {}),
    ...(event === "invoice_paid" ? { paidOn: "2026-01-15" } : {}),
    ...(event === "quote_accepted" ? { acceptedOn: "2026-01-01" } : {}), sample: true };
}
