import { z } from 'zod';

export const isLinkProperty = (type: string) => type === 'url' || type === 'email';
export const propertyEmailSchema = z.string().trim().max(254).email('Enter a valid email address.').transform(value => {
  const at = value.lastIndexOf('@');
  return value.slice(0, at + 1) + value.slice(at + 1).toLowerCase();
});
export const propertyURLSchema = z.string().trim().max(2048).transform((value, ctx) => {
  try {
    if (!value || /[\s\\\u0000-\u001f\u007f]/u.test(value)) throw Error();
    const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^/?#@:]+:\d+(?:[/?#]|$)/.test(value);
    const url = new URL(hasScheme ? value : 'https://' + value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw Error();
    const result = url.href;
    if (result.length > 2048) throw Error();
    return result;
  } catch {
    ctx.addIssue({code:'custom', message:'Enter a valid HTTP or HTTPS URL (without a username or password).'});
    return z.NEVER;
  }
});
export const propertyDomainSchema = z.string().trim().min(1).max(253).transform((value, ctx) => {
  try {
    if (/[\s/:?#@*\\]/u.test(value)) throw Error();
    const host = new URL('https://' + value).hostname.replace(/\.$/, '').toLowerCase();
    if (!host || host.length > 253 || !host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) throw Error();
    return host;
  } catch {
    ctx.addIssue({code:'custom', message:'Enter domain names only, such as example.com, without a URL, port or wildcard.'});
    return z.NEVER;
  }
});
export function propertyLinkHref(type: string, value: unknown): string | undefined {
  if (type === 'url') { const parsed = propertyURLSchema.safeParse(value); return parsed.success ? parsed.data : undefined; }
  if (type === 'email') { const parsed = propertyEmailSchema.safeParse(value); return parsed.success ? 'mailto:' + encodeURIComponent(parsed.data).replace('%40', '@') : undefined; }
}
export function propertyLinkDomain(type: string, value: unknown): string | undefined {
  if (type === 'url') { const parsed = propertyURLSchema.safeParse(value); return parsed.success ? new URL(parsed.data).hostname.replace(/\.$/, '').toLowerCase() : undefined; }
  if (type === 'email') { const parsed = propertyEmailSchema.safeParse(value); return parsed.success ? parsed.data.slice(parsed.data.lastIndexOf('@') + 1) : undefined; }
}

export const linkTextSchema = z.string().trim().max(200);
export const urlEditSchema = z.object({url:z.string().max(2048),linkText:linkTextSchema}).strict();
export const linkTextValueSchema = z.object({url:propertyURLSchema,text:linkTextSchema}).strict();
export type LinkTextValue = z.infer<typeof linkTextValueSchema>;
export function customURLText(data:{custom?:Record<string,unknown>;customLinkText?:Record<string,LinkTextValue>}, id:string):string {
  const saved=data.customLinkText?.[id];
  return saved&&saved.url===data.custom?.[id] ? saved.text : '';
}
export function urlDisplayText(data:{custom?:Record<string,unknown>;customLinkText?:Record<string,LinkTextValue>}, property:{id:string;linkText?:string|null;allowCustomLinkText?:boolean}):string {
  return (property.allowCustomLinkText ? customURLText(data,property.id) : '') || property.linkText || String(data.custom?.[property.id]||'');
}
export function urlEditorValue(data:{custom?:Record<string,unknown>;customLinkText?:Record<string,LinkTextValue>},field:{id:string;type:string;allowCustomLinkText?:boolean}) {
  if(field.type==='url'&&field.allowCustomLinkText&&field.id.startsWith('custom:'))return {url:String(data.custom?.[field.id.slice(7)]||''),linkText:customURLText(data,field.id.slice(7))};
}
