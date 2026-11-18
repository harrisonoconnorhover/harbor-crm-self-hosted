export type TaskAssignee={userId:string;workspaceId:string;label:string};
// This is assignment, not authorization. A legacy name never establishes an
// identity. Changing that name through older editors/imports breaks the link.
export function taskAssignee(data:{owner?:unknown;taskAssignee?:unknown},workspaceId?:string):TaskAssignee|null{
 const a=data.taskAssignee as TaskAssignee|undefined;
 return a&&typeof a.userId==='string'&&a.userId.length>0&&a.userId.length<=200&&typeof a.workspaceId==='string'&&typeof a.label==='string'&&a.label===data.owner&&(!workspaceId||a.workspaceId===workspaceId)?a:null;
}
