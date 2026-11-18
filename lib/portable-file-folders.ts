import {z} from 'zod';
import {fileFolderNameInput} from './file-library';

const id=z.string().guid("Invalid uuid").transform(value=>value.toLowerCase());
const expectedRevision=z.number().int().min(0).max(2147483646);
export const portableFolderPage=z.object({
  after:id.optional(),parentId:z.union([z.literal('root'),id]).optional(),
}).strict();
export const portableFolderWrite=z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),id,name:fileFolderNameInput,parentId:id.nullable().optional()}).strict(),
  z.object({action:z.literal('rename'),id,expectedRevision,name:fileFolderNameInput}).strict(),
  z.object({action:z.literal('moveFolder'),id,expectedRevision,parentId:id.nullable()}).strict(),
  z.object({action:z.literal('remove'),id,expectedRevision}).strict(),
  z.object({action:z.literal('move'),contactId:id,fileId:id,versionId:id,expectedRevision,folderId:id.nullable()}).strict(),
]);
export type PortableFolderWrite=z.output<typeof portableFolderWrite>;
