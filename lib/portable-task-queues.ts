import {z} from 'zod';
import {queueName} from './task-queues';

export const portableTaskQueueLimit=50;
const portableTaskQueueSelectionLimit=50;
export const portableTaskQueueInput=z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),id:z.string().guid("Invalid uuid"),name:queueName}).strict(),
  z.object({action:z.literal('rename'),id:z.string().guid("Invalid uuid"),revision:z.number().int().min(1).max(2147483646),name:queueName}).strict(),
  z.object({action:z.literal('remove'),id:z.string().guid("Invalid uuid"),revision:z.number().int().min(1).max(2147483647)}).strict(),
  z.object({action:z.literal('assign'),queueId:z.string().guid("Invalid uuid").toLowerCase().nullable(),tasks:z.array(z.object({
    id:z.string().guid("Invalid uuid").toLowerCase(),expectedRevision:z.number().int().min(1).max(2147483647),
  }).strict()).min(1).max(portableTaskQueueSelectionLimit).refine(tasks=>new Set(tasks.map(task=>task.id)).size===tasks.length)}).strict(),
]);
export type PortableTaskQueueInput=z.output<typeof portableTaskQueueInput>;
export type PortableTaskQueue={id:string;name:string;revision:number};
