import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {readOwnerAccessRoster} from '../db/postgres/workspace-viewer-store';
import {teamAncestors} from '../lib/portable-workspace-teams';
import {memberTools,memberToolNames,type MemberToolPolicy} from '../lib/portable-tool-permissions';
import {exportCsvCell} from '../lib/shared-record-export';

const yesNo=(value:boolean)=>value?'Yes':'No';

function toolSetting(policy:MemberToolPolicy|undefined){
  if(!policy)return 'Default';
  return ['View '+policy.view,'Create '+yesNo(policy.create),'Edit '+policy.edit,'Delete '+yesNo(policy.delete)].join(' / ');
}

export async function teammateAccessCsv(db:PostgresJsDatabase,ownerId:string,workspaceId:string,method:string){
  const roster=await readOwnerAccessRoster(db,ownerId,workspaceId);
  const headers={'cache-control':'private, no-store'};
  if(!roster)return Response.json({error:'Workspace unavailable.'},{status:404,headers});
  const capturedAt=new Date().toISOString();
  const filename='harbor-teammate-access-'+workspaceId+'-'+capturedAt.slice(0,10)+'.csv';
  const download={...headers,'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="'+filename+'"'};
  if(method==='HEAD')return new Response(null,{headers:download});
  const columns=['Captured at (UTC)','Workspace ID','Teammate ID','Email','Role','Membership source','Primary team','Primary team ID',
    'Directory manages primary team','Default record view','Default record edit','Backup administrator','Contact files',
    'Scheduled notes','Contact outreach','Company and deal activities',...memberTools.map(tool=>memberToolNames[tool]+' override')];
  const rows=roster.members.map(member=>[capturedAt,workspaceId,member.actorId,member.email,member.role,
    roster.directoryUsers.has(member.actorId)?'Company directory':'Harbor',teamAncestors(roster.teams,member.teamId).map(team=>team.name).join(' / '),
    member.teamId??'',yesNo(member.directoryTeamManaged),member.viewScope,member.editScope,yesNo(member.backupAdmin),yesNo(member.contactFiles),
    yesNo(member.scheduledNotes),yesNo(member.contactOutreach),yesNo(member.recordActivities),...memberTools.map(tool=>toolSetting(member.toolPolicies[tool]))]);
  const csv=[columns,...rows].map(cells=>cells.map(cell=>exportCsvCell(cell)).join(',')).join('\r\n')+'\r\n';
  return new Response(csv,{headers:download});
}
