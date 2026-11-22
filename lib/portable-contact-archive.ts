import {z} from 'zod';

const id=z.string().guid("Invalid uuid");
export const portableArchiveKind=z.enum(['contacts','companies','deals','tasks','leads','tickets']);
// A shared Recycle Bin names the workspace and the editor's grant, like other shared writes.
export const portableArchiveQuery=z.object({kind:portableArchiveKind.optional(),after:id.optional(),
  workspaceId:id.optional(),grantId:id.optional()}).strict().refine(value=>!value.workspaceId===!value.grantId);
export const portableArchiveAction=z.object({
  kind:portableArchiveKind.optional(),action:z.enum(['archive','restore']),id,requestId:id,expectedRevision:z.number().int().min(1).max(2147483646),
}).strict();

export type PortableArchiveKind=z.output<typeof portableArchiveKind>;
export type PortableArchiveInput=z.output<typeof portableArchiveAction>;
export type PortableArchiveReceipt={
  id:string;action:PortableArchiveInput['action'];revision:number;archivedAt:string|null;nextTaskId?:string;
};
export type PortableArchivedRecord={id:string;name:string;email?:string;domain?:string;revision:number;archivedAt:string;archivedBy:string|null};
