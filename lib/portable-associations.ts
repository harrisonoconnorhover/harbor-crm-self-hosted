import {z} from 'zod';
import {portableRecordKind} from './portable-records';

const uuid=z.string().guid("Invalid uuid").transform(value=>value.toLowerCase());
const endpoint={kind:portableRecordKind,id:uuid};
const labels=z.array(z.string().trim().min(1).max(80).refine(value=>!value.includes('\0'))).max(5)
  .transform(values=>[...new Set(values)].sort());
export const portableAssociationLabelInput=z.object({labels}).strict();
export const portableAssociationQuery=z.object({...endpoint,after:uuid.optional(),workspaceId:uuid.optional()}).strict();
export const portableAssociationAction=z.discriminatedUnion('action',[
  z.object({action:z.literal('link'),target:z.object(endpoint).strict(),labels}).strict(),
  z.object({action:z.literal('relabel'),linkId:uuid,expectedLabels:labels,labels}).strict(),
  z.object({action:z.literal('unlink'),linkId:uuid,expectedLabels:labels.optional()}).strict(),
]);
export type PortableAssociationQuery=z.output<typeof portableAssociationQuery>;
export type PortableAssociationAction=z.output<typeof portableAssociationAction>;
