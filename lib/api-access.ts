import { z } from "zod";
import { kinds } from "./crm";

export const apiObjects = [...kinds, "products", "quotes", "invoices", "activities", "files", "inquiries"] as const;
export type ApiObject = typeof apiObjects[number];

export const tokenInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    objects: z.array(z.enum(apiObjects)).min(1).max(apiObjects.length),
    permission: z.enum(["read", "read_write", "read_write_archive"]),
    deleteActivities: z.boolean().default(false),
    deleteFiles: z.boolean().default(false),
    days: z.union([z.literal(30), z.literal(90), z.literal(365)]),
  })
  .strict().refine(v=>!v.deleteActivities||(v.objects.includes("activities")&&v.permission!=="read"),"Activity deletion requires Activities with write permission.").refine(v=>!v.deleteFiles||(v.objects.includes("files")&&v.permission!=="read"),"File deletion requires Files with write permission.")
  .refine(v=>!v.objects.includes("inquiries")||(v.objects.length===1&&v.permission==="read_write"),"Use a separate write token for form inquiries.");
export type ApiTokenInfo = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};
export async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export function newToken() {
  return (
    "harbor_" +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("")
  );
}

export function tokenScopes(objects:ApiObject[],permission:z.infer<typeof tokenInput>['permission'],deleteActivities=false,deleteFiles=false){
 const scopes=[...new Set(objects)].flatMap(kind=>kind==='inquiries'?[...(permission==='read_write'?['inquiries:write']:[])]:[`${kind}:read`,...(permission==='read'?[]:[`${kind}:write`]),...(permission==='read_write_archive'&&(kinds as readonly string[]).includes(kind)?[`${kind}:archive`]:[])]);
 if(deleteActivities&&permission!=='read'&&objects.includes('activities'))scopes.push('activities:delete');
 if(deleteFiles&&permission!=='read'&&objects.includes('files'))scopes.push('files:delete');
 return scopes;
}
