import {portableCustomProperties as properties,portableStandardPropertyAccess as standard} from './custom-property-schema';
import {and,asc,eq,gt,isNull,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {directoryTeamLimit,teamAncestors,type TeamChange} from '../../lib/portable-workspace-teams';
import {teamNameKey} from '../../lib/workspace-teams';
import {lockRecordWorkspace} from './private-workspace-store';
import {workspaceTeams as teams} from './workspace-team-schema';
import {directoryGroups as groups,directoryGroupMembers as assignments} from './workspace-directory-schema';
import {workspaceInvites} from './workspace-invite-schema';
import {workspaceViewers as members} from './workspace-viewer-schema';

type Transaction=Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
// An access preview starts at the current membership. Return only paths in that
// branch so teammates can distinguish identically named pods under different parents.
export const memberTeamPaths=sql<string[]>`(
  WITH RECURSIVE branch(id,ids,path) AS (
    SELECT t.id,ARRAY[t.id],ARRAY[t.name] FROM ${teams} t
    WHERE t.workspace_id=${members.workspaceId} AND t.id=${members.teamId}
    UNION ALL
    SELECT c.id,array_append(b.ids,c.id),array_append(b.path,c.name)
    FROM branch b JOIN ${teams} c ON c.workspace_id=${members.workspaceId} AND c.parent_id=b.id
    WHERE NOT c.id=ANY(b.ids)
  )
  SELECT coalesce(jsonb_agg(array_to_string(path,' / ') ORDER BY path),'[]'::jsonb) FROM branch
)`;
export function readDirectoryTeams(db:PostgresJsDatabase,workspaceId:string){
  return db.select({id:teams.id,name:teams.name,parentId:teams.parentId,revision:teams.revision}).from(teams)
    .where(eq(teams.workspaceId,workspaceId)).orderBy(asc(teams.nameKey),asc(teams.id)).limit(directoryTeamLimit);
}

export function teamAssignmentPolicy(tx:Transaction,workspaceId:string,directory:Awaited<ReturnType<typeof readDirectoryTeams>>){
  const protectsField=async(id:string)=>(await tx.execute(sql`SELECT 1 FROM ${properties}
    WHERE ${properties.workspaceId}=${workspaceId} AND ${properties.visibleTeamId}=${id}
    UNION ALL SELECT 1 FROM ${standard} WHERE ${standard.workspaceId}=${workspaceId} AND ${standard.visibleTeamId}=${id}
    LIMIT 1`)).length>0;
  const mappedTeamIds=async()=>new Set((await tx.select({id:groups.teamId}).from(groups)
    .where(eq(groups.workspaceId,workspaceId))).map(row=>row.id));
  const mappedAncestors=(mapped:Set<string>,teamId:string|null)=>
    teamAncestors(directory,teamId).filter(team=>mapped.has(team.id)).map(team=>team.id).join(',');
  const containsMapped=(mapped:Set<string>,teamId:string|null)=>
    [...mapped].some(id=>teamAncestors(directory,id).some(parent=>parent.id===teamId));
  async function assignmentProblem(previous:string|null,next:string|null,delegated:boolean){
    if(next&&!directory.some(team=>team.id===next))return 'Team unavailable. Refresh the directory.';
    if(!delegated||previous===next)return;
    const mapped=await mappedTeamIds();
    if(containsMapped(mapped,previous)||containsMapped(mapped,next)||mappedAncestors(mapped,previous)!==mappedAncestors(mapped,next))
      return 'Ask the owner to change assignments into or out of a directory-mapped team.';
    if(next&&await protectsField(next))return 'Ask the owner to assign members to a team with restricted properties.';
  }
  return {assignmentProblem,protectsField,mappedTeamIds,mappedAncestors,containsMapped};
}

export async function changeDirectoryTeam(tx:Transaction,ownerId:string,change:TeamChange,delegated:boolean){
  // Serialize tree mutations so two valid moves cannot jointly introduce a cycle.
  const workspaceId=await lockRecordWorkspace(tx,ownerId,change.action==='team_create',undefined,undefined,true);
  if(!workspaceId)return 'Workspace unavailable. Refresh the directory.';
  const directory=await readDirectoryTeams(tx,workspaceId);
  const find=(id:string)=>directory.find(team=>team.id===id);
  const policy=teamAssignmentPolicy(tx,workspaceId,directory);
  if(change.action==='team_assign'){
    const [managed]=await tx.select({id:members.id}).from(members)
      .innerJoin(assignments,and(eq(assignments.workspaceId,members.workspaceId),eq(assignments.userId,members.viewerId)))
      .where(and(eq(members.workspaceId,workspaceId),eq(members.id,change.id)));
    if(managed)return 'Manage this primary team through the directory group.';
    const problem=await policy.assignmentProblem(change.previousTeamId,change.teamId,delegated);
    if(problem)return problem;
    const [changed]=await tx.update(members).set({teamId:change.teamId}).where(and(
      eq(members.workspaceId,workspaceId),eq(members.id,change.id),
      change.previousTeamId?eq(members.teamId,change.previousTeamId):isNull(members.teamId),
      delegated?eq(members.backupAdmin,false):undefined,
    )).returning({id:members.id});
    return changed?undefined:'Membership changed. Refresh the directory.';
  }
  const team=find(change.id);
  if(change.action!=='team_create'&&team?.revision!==change.revision)return 'Team changed. Refresh the directory.';
  const target=and(eq(teams.workspaceId,workspaceId),eq(teams.id,change.id));
  if(change.action==='team_remove'){
    if((await policy.mappedTeamIds()).has(change.id))return 'The owner must unmap the directory group before deleting this team.';
    const [member]=await tx.select({id:members.id}).from(members)
      .where(and(eq(members.workspaceId,workspaceId),eq(members.teamId,change.id))).limit(1);
    if(member||directory.some(item=>item.parentId===change.id))return 'Move the members and child teams before deleting this team.';
    if(await policy.protectsField(change.id))return 'Change the visibility of the properties assigned to this team before deleting it.';
    const [pending]=await tx.select({id:workspaceInvites.id}).from(workspaceInvites).where(and(
      eq(workspaceInvites.workspaceId,workspaceId),eq(workspaceInvites.teamId,change.id),gt(workspaceInvites.expiresAt,sql`clock_timestamp()`))).limit(1);
    if(pending)return 'Cancel pending invitations for this team before deleting it.';
    await tx.delete(teams).where(target);
    return;
  }
  if(change.action==='team_create'&&team){
    if(team.name===change.name&&team.parentId===change.parentId)return;
    return 'Team already exists. Refresh the directory.';
  }
  if(change.parentId&&!find(change.parentId))return 'Parent team unavailable. Refresh the directory.';
  if(teamAncestors(directory,change.parentId).some(item=>item.id===change.id))return 'A team cannot be placed inside itself or one of its child teams.';
  if(delegated&&team&&team.parentId!==change.parentId){
    const mapped=await policy.mappedTeamIds();
    if(policy.containsMapped(mapped,team.id)||policy.mappedAncestors(mapped,team.parentId)!==policy.mappedAncestors(mapped,change.parentId))
      return 'Ask the owner to move teams that affect a directory-mapped team.';
  }
  const nameKey=teamNameKey(change.name);
  if(directory.some(item=>item.id!==change.id&&item.parentId===change.parentId&&teamNameKey(item.name)===nameKey))
    return 'A team with that name already exists under this parent.';
  const values={name:change.name,nameKey,parentId:change.parentId};
  if(change.action==='team_create'){
    if(directory.length>=directoryTeamLimit)return 'This workspace already has '+directoryTeamLimit+' teams.';
    await tx.insert(teams).values({workspaceId,id:change.id,...values});
  }else{
    await tx.update(teams).set({...values,revision:change.revision+1}).where(target);
  }
}
