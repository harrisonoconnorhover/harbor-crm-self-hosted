import {z} from 'zod';

export const publicTopic=z.string().trim().min(1).max(80).regex(/^[^\p{Cc}]+$/u);
const revision=z.number().int().nonnegative();
export const helpChange=z.discriminatedUnion('action',[
  z.object({action:z.literal('settings'),revision,name:z.string().trim().min(1).max(80),
    accent:z.string().regex(/^#[0-9a-f]{6}$/i),enabled:z.boolean()}).strict(),
  z.object({action:z.literal('publish'),topic:publicTopic.nullable().optional(),id:z.string().guid(),articleRevision:revision.positive(),revision}).strict(),
  z.object({action:z.literal('withdraw'),id:z.string().guid(),articleRevision:revision.positive(),revision}).strict(),
]);
export type HelpChange=z.infer<typeof helpChange>;
export type HelpSettings={id:string;name:string;accent:string;enabled:boolean;revision:number};
export type HelpState={center:HelpSettings|null;publication:{topic:string|null;publishedRevision:number|null;revision:number}|null};

// Plain article IDs remain valid for earlier links and unfiltered browsing.
const articleCursor=z.union([z.string().guid(),z.string().regex(/^[0-2]:/).refine(value=>z.string().guid().safeParse(value.slice(2)).success)]);
export const helpArticleSearch=z.object({
  workspaceId:z.string().guid().optional(),q:z.string().trim().max(200).optional(),topic:publicTopic.optional(),after:articleCursor.optional(),
}).strict();
