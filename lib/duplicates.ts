import type { CRMRecord } from "./crm";

export type DuplicateKind = "contacts" | "companies";
export type DuplicatePair = { left: CRMRecord; right: CRMRecord; score: number; reasons: string[]; dismissedAt?: string };
export type DuplicateCursor = [number, string, string];
export const duplicateKey = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);
const text = (value: string | undefined) => (value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
export const duplicateCompanySuffixes=["inc","incorporated","llc","ltd","limited","corp","corporation","company","co"];
export function duplicateName(record: CRMRecord) {
  const words = text(record.data.name).split(" ");
  if (record.kind === "companies") while (words.length > 1 && duplicateCompanySuffixes.includes(words.at(-1)!)) words.pop();
  return words.join(" ");
}
export function duplicateDomain(value: string | undefined) {
  if (!value?.trim()) return "";
  try {
    const url = new URL(value.includes("://") ? value.trim() : "https://" + value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return host.includes(".") && !host.includes(" ") ? host : "";
  } catch { return ""; }
}
const email = (r: CRMRecord) => (r.data.email || "").trim().toLowerCase();
const phone = (r: CRMRecord) => { const digits = (r.data.phone || "").replace(/\D/g, ""); return digits.length >= 7 && digits.length <= 15 ? digits : ""; };
const numbers = (name: string) => (name.match(/\d+/g) || []).join("|");
export function similarDuplicateName(a: string, b: string) {
  if (a === b) return !!a;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1 || numbers(a) !== numbers(b)) return false;
  let start = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  if (a.length === b.length) return a.slice(start + 1) === b.slice(start + 1) || (a[start] === b[start + 1] && a[start + 1] === b[start] && a.slice(start + 2) === b.slice(start + 2));
  return a.length > b.length ? a.slice(start + 1) === b.slice(start) : a.slice(start) === b.slice(start + 1);
}
function companyKey(record: CRMRecord, all: Map<string, CRMRecord>) {
  const company = all.get(record.data.companyId || "");
  return company?.kind === "companies" ? duplicateName(company) : "";
}
export function duplicateEvidence(left: CRMRecord, right: CRMRecord, all: Map<string, CRMRecord>) {
  if (left.id === right.id || left.kind !== right.kind || !["contacts", "companies"].includes(left.kind)) return null;
  const a = duplicateName(left), b = duplicateName(right), sameName = !!a && a === b;
  const similar = similarDuplicateName(a, b), reasons: string[] = [];
  let score = 0;
  const add = (value: number, reason: string) => { score = Math.max(score, value); reasons.push(reason); };
  if (left.kind === "contacts") {
    if (email(left) && email(left) === email(right)) add(100, "Same email address");
    if (phone(left) && phone(left) === phone(right) && sameName) add(95, "Same name and phone number");
    const company = companyKey(left, all);
    if (company && company === companyKey(right, all) && similar) add(sameName ? 90 : 75, sameName ? "Same name and primary company" : "Similar name and same primary company");
    if (sameName && a.includes(" ") && a.length >= 6) add(70, "Same full name");
  } else {
    const domain = duplicateDomain(left.data.domain);
    if (domain && domain === duplicateDomain(right.data.domain)) add(100, "Same company domain");
    const city = text(left.data.city);
    if (city && city === text(right.data.city) && similar) add(sameName ? 90 : 75, sameName ? "Same company name and city" : "Similar company name and same city");
    if (sameName && a.length >= 3) add(70, "Same company name (ignoring legal suffixes)");
  }
  return score ? { left, right, score, reasons } satisfies DuplicatePair : null;
}
export const pairCursor = (pair: DuplicatePair): DuplicateCursor => [pair.score, pair.left.id, pair.right.id];
export function compareDuplicateCursor(a: DuplicateCursor, b: DuplicateCursor) {
  return b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}
// Exact identity blocks run first. Name deletion signatures find single-character
// edits/transpositions without comparing every record with every other record.
export function findDuplicates(records: CRMRecord[], kind: DuplicateKind, pairLimit = 10_000, options: { excluded?: Set<string>; query?: string; strength?: "all" | "strong" | "possible" } = {}) {
  const all = new Map(records.map(r => [r.id, r])), rows = records.filter(r => r.kind === kind).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const query=options.query?.trim().toLowerCase();
  const hits=query?new Set(rows.filter(record=>[record.data.name,record.data.email,record.data.domain]
    .some(value=>value?.toLowerCase().includes(query))).map(record=>record.id)):undefined;
  if(hits&&!hits.size)return {pairs:[] as DuplicatePair[],limited:false,recordsChecked:rows.length};
  const blocks = [new Map<string, CRMRecord[]>(), new Map<string, CRMRecord[]>(), new Map<string, CRMRecord[]>()];
  function add(tier: number, key: string, record: CRMRecord) { if (!key) return; const group = blocks[tier].get(key); if (group) group.push(record); else blocks[tier].set(key, [record]); }
  for (const record of rows) {
    const name = duplicateName(record);
    add(0, kind === "contacts" ? email(record) : duplicateDomain(record.data.domain), record);
    if (name.length >= 3) add(1, name, record);
    const support = kind === "contacts" ? companyKey(record, all) : text(record.data.city);
    if (support && name.length >= 5) {
      const signatures = new Set([name, ...Array.from({length: name.length}, (_,i) => name.slice(0,i) + name.slice(i+1))]);
      for (const signature of signatures) add(2, JSON.stringify([support, numbers(name), signature]), record);
    }
  }
  const seen = new Set<string>(), pairs: DuplicatePair[] = [];
  let limited = false;
  scan: for (const tier of blocks) for (const group of tier.values()) {
    if(group.length<2)continue;
    const matching=hits?group.flatMap((row,index)=>hits.has(row.id)?[index]:[]):undefined;
    if(matching?.length===0)continue;
    let nextMatch=0;
    for(let i=0;i<group.length-1;i++){
      // Keep the original (left ID, right ID) traversal, including when the scan hits a limit.
      // A matching left record pairs with every later record. Other left records only visit later hits.
      const leftMatches=matching?.[nextMatch]===i;
      if(leftMatches)nextMatch++;
      const partners=leftMatches?undefined:matching;
      for(let n=partners?nextMatch:i+1;n<(partners?.length??group.length);n++){
        const left=group[i],right=group[partners?partners[n]:n];
        const key=duplicateKey(left.id,right.id);
        if(seen.has(key)||options.excluded?.has(key))continue;
        if(pairs.length>=pairLimit||seen.size>=100_000){limited=true;break scan;}
        seen.add(key);
        const pair=duplicateEvidence(left,right,all);
        if(pair&&(options.strength!=="strong"||pair.score>=90)&&(options.strength!=="possible"||pair.score<90))pairs.push(pair);
      }
    }
  }
  pairs.sort((a,b) => compareDuplicateCursor(pairCursor(a), pairCursor(b)));
  return { pairs, limited, recordsChecked: rows.length };
}
export type DuplicatePage = {
  pairs: DuplicatePair[];
  nextCursor: string | null;
  total: number;
  limited: boolean;
  recordsChecked: number;
  checkedAt: string;
};
