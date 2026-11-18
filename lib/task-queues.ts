import { z } from "zod";
import type { CRMRecord } from "./crm";

export type TaskQueue = { id: string; name: string; revision: number; shared?: boolean };
export const NO_QUEUE = "__none__";
export const queueName = z
  .string()
  .trim()
  .min(1, "Enter a queue name.")
  .max(80);
export const queueAssignment = z.object({
  action: z.literal("assign"),
  queueId: z.string().guid("Invalid uuid").nullable(),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        expected: z.string().guid("Invalid uuid").nullable(),
      }),
    )
    .min(1)
    .max(500)
    .refine(
      (tasks) => new Set(tasks.map((t) => t.id)).size === tasks.length,
      "Select each task only once.",
    ),
});
export function matchesTaskQueue(record: CRMRecord, queueId = "") {
  if (record.kind !== "tasks" || !queueId) return true;
  return queueId === NO_QUEUE ? !record.queueId : record.queueId === queueId;
}

export const taskQueueInput=z.union([
 queueAssignment,
 z.object({action:z.literal('create'),name:queueName}),
 z.object({action:z.literal('rename'),id:z.string().guid("Invalid uuid"),revision:z.number().int().positive(),name:queueName}),
 z.object({action:z.literal('delete'),id:z.string().guid("Invalid uuid"),revision:z.number().int().positive()}),
]);
export type TaskQueueInput=z.infer<typeof taskQueueInput>;
