import {z} from 'zod';

export const quoteSigningConsent='I have reviewed this quote and agree to its terms. By typing my name and selecting Sign quote, I sign this version electronically.';
export const signingLinkChange=z.object({
  action:z.enum(['issue-signing-link','revoke-signing-link']),id:z.string().guid(),
  revision:z.number().int().positive(),version:z.number().int().positive(),expectedLink:z.string().guid().nullable(),
}).strict();
const token=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const buyerSigningForm=z.discriminatedUnion('action',[
  z.object({action:z.enum(['review','download']),token}).strict(),
  z.object({action:z.literal('sign'),token,name:z.string().trim().min(1).max(160),
    consent:z.literal('yes'),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export type QuoteSignatureReceipt={id:string;signedName:string;signedAt:string;consent:string;digest:string};
