import type {RecordOwner} from './record-owner';
// Identity controls the bucket; captured display names may differ after a rename.
export function ownerReportGroup(owner:unknown,member:RecordOwner|undefined){
 if(member)return {key:JSON.stringify(['member',member.workspaceId,member.userId]),label:String(owner||'Workspace member')};
 return owner?{key:JSON.stringify(['name',String(owner)]),label:`${owner} (stored name)`}:{key:'missing',label:'Unassigned'};
}
export function labelOwnerReportGroups<T extends {key:string;label:string;groupIdentity?:string|null}>(rows:T[]):T[]{
 const counts=new Map<string,number>(),suffixes=new Map<string,number>();
 for(const row of rows){counts.set(row.label,(counts.get(row.label)||0)+1);const key=row.key==='missing'?[]:JSON.parse(row.key);if(key[0]==='member'){const suffix=JSON.stringify([row.label,key[2].slice(-8)]);suffixes.set(suffix,(suffixes.get(suffix)||0)+1);}}
 for(const row of rows){const key=row.key==='missing'?[]:JSON.parse(row.key);row.groupIdentity=key[0]==='member'?JSON.stringify(key.slice(1)):null;if(row.groupIdentity&&(counts.get(row.label)||0)>1)row.label+=' · '+((suffixes.get(JSON.stringify([row.label,key[2].slice(-8)]))||0)>1?row.groupIdentity:key[2].slice(-8));}
 return rows;
}
