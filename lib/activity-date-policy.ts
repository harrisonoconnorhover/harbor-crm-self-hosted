// Shared meaning of computed outreach dates; timeline visibility is independent.
export const messageActivityTypes = ['LinkedIn','SMS','WhatsApp'] as const;
export const outreachActivityTypes = ['Email','Call','Meeting',...messageActivityTypes] as const;
export const datedActivityTypes = ['Note',...outreachActivityTypes,'Postal mail'] as const;
export type ActivityType = typeof datedActivityTypes[number];
export const directionalActivityTypes:readonly string[] = ['Call','Email',...messageActivityTypes];
export function activityTypeLabel(type:string,plural=false):string {
 if(type==='Postal mail')return type;
 if(messageActivityTypes.some(t=>t===type))return type+(plural?' messages':' message');
 return type+(plural?'s':'');
}
const actionTypeLabel=(type:string)=>activityTypeLabel(type).replace(/^(Note|Call|Email|Meeting|Postal)/,s=>s.toLowerCase());
export const activityLogLabel=(type:string)=>type==='Note'?'Add note':'Log '+actionTypeLabel(type);
export const activitySaveLabel=(type:string)=>'Save '+actionTypeLabel(type);
export function pastActivityDate(activity:{occurredAt?:string|null;createdAt:string},asOf:Date):string|undefined {
 const occurred=Date.parse(activity.occurredAt||activity.createdAt),created=Date.parse(activity.createdAt),cutoff=asOf.getTime();
 return Number.isFinite(occurred)&&Number.isFinite(created)&&occurred<=cutoff&&created<=cutoff?new Date(occurred).toISOString():undefined;
}

export function latestActivityDate(...dates:(string|null|undefined)[]):string|undefined {
 const valid=dates.filter((d):d is string=>!!d&&Number.isFinite(Date.parse(d)));
 return valid.length?new Date(Math.max(...valid.map(d=>Date.parse(d)))).toISOString():undefined;
}
