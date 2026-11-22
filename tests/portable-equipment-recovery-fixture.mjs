import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const email='invitee@example.test';
const api='/api/custom-objects';
const equipmentName='West warehouse scanner';
async function read(response){
  const result=await response;
  assert.ok(result.ok,await result.clone().text());
  return result.json();
}
const write=(request,origin,headers,path,data)=>read(request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(data)}));

async function admitRep(request,origin,owner,rep,role){
  const team='/api/workspaces';
  const {sent}=await write(request,origin,owner,team,{action:'invite',email,role,viewScope:'owned',editScope:'owned'});
  await write(request,origin,rep,team,{action:'accept_invite',id:sent.find(row=>row.email===email).id});
  const {viewers}=await read(request(team,{headers:owner}));
  return viewers.find(row=>row.email===email);
}

export async function seedEquipmentImport({request,origin,owner,rep,workspace,objectId,existingId,serialId,contactId}){
  const member=await admitRep(request,origin,owner,rep,'editor');
  const accessPath='/api/workspaces?'+new URLSearchParams({view:'teammate-access',export:'csv',workspaceId:workspace});
  const roster=await request(accessPath,{headers:owner});
  assert.equal(roster.status,200);
  const originalAccess=await roster.text();
  assert.ok(originalAccess.includes(member.actorId)&&originalAccess.includes(email));

  const csv='Record ID,Name,Serial number\n'+existingId+',,DS-482-R\n,'+equipmentName+',WS-905';
  const list=api+'?objectId='+objectId;
  const post=body=>write(request,origin,owner,api,body);
  const {review,rows}=await post({action:'preview_csv',objectId,csv});
  assert.deepEqual(rows.map(row=>row.state),['update','create']);
  const command={action:'apply_csv',objectId,csv,review,requestId:randomUUID()};
  const receipt=await post(command);
  assert.deepEqual(receipt,{created:1,updated:1,skipped:0});
  const {items}=await read(request(list,{headers:owner}));
  const imported=items.find(row=>row.name===equipmentName);
  assert.ok(imported);
  const {record}=await read(request(list+'&record='+imported.id,{headers:owner}));
  const assigned=await post({action:'save',id:imported.id,objectId,revision:record.revision,schemaRevision:1,
    name:equipmentName,assigneeId:member.actorId,values:{[serialId]:'WS-905'}});
  await post({action:'link',id:imported.id,objectId,revision:assigned.revision,kind:'contacts',target:contactId});
  const scoped=list+'&workspaceId='+workspace;
  assert.deepEqual((await read(request(scoped,{headers:rep}))).items.map(item=>item.id),[imported.id]);
  const history='/api/workflows?'+new URLSearchParams({runObjectId:objectId,runCustomRecordId:imported.id});
  const {runs}=await read(request(history,{headers:owner}));
  assert.equal(runs.length,1);
  assert.ok(runs[0].customTaskId);
  return {accessPath,originalAccess,command,receipt,importedId:imported.id,list,scoped,history,runs};
}

export async function verifyRestoredEquipmentImport({scenario,request,origin,owner,rep,workspace,serialId,existingId,contactId,attachment}){
  const {command,receipt,importedId,list,scoped,history,runs}=scenario;
  const detail=list+'&record='+importedId;
  const shared=scoped+'&record='+importedId;
  assert.equal((await request(shared,{headers:rep})).status,404);
  const saved=await read(request(detail,{headers:owner}));
  assert.equal(saved.record.data.values[serialId],'WS-905');
  assert.deepEqual(saved.items.map(link=>link.target),[contactId]);
  assert.deepEqual(await write(request,origin,owner,api,command),receipt);
  assert.deepEqual((await read(request(list,{headers:owner}))).items.map(row=>row.id).sort(),[existingId,importedId].sort());
  assert.deepEqual((await read(request(detail,{headers:owner}))).record,saved.record);
  assert.deepEqual((await read(request(history,{headers:owner}))).runs,runs);

  // Restores omit memberships. Regrant only the rep's own records, leaving the
  // contact and its attachment private even though the equipment links to it.
  const emptyRoster=await request(scenario.accessPath,{headers:owner});
  assert.equal(emptyRoster.status,200);
  assert.equal((await emptyRoster.text()).trimEnd(),scenario.originalAccess.split('\r\n')[0]);
  const member=await admitRep(request,origin,owner,rep,'viewer');
  const currentRoster=await request(scenario.accessPath,{headers:owner});
  assert.equal(currentRoster.status,200);
  const updatedAccess=await currentRoster.text();
  assert.ok(updatedAccess.includes(member.actorId)&&updatedAccess.includes('"viewer"'));
  assert.ok(scenario.originalAccess.includes('"editor"'));
  const visible=await read(request(shared,{headers:rep}));
  assert.equal(visible.record.name,equipmentName);
  assert.equal(visible.record.editable,false);
  assert.deepEqual(visible.items,[]);
  const attemptedEdit=await request(api+'?'+new URLSearchParams({workspaceId:workspace,grantId:member.id}),{
    method:'POST',headers:{...rep,origin,'content-type':'application/json'},body:JSON.stringify({
      action:'save',objectId:command.objectId,id:importedId,revision:visible.record.revision,schemaRevision:saved.type.revision,
      name:'Viewer edit',values:visible.record.data.values,
    }),
  });
  assert.equal(attemptedEdit.status,403);
  assert.equal((await read(request(detail,{headers:owner}))).record.name,equipmentName);
  const linkedContact='/api/crm?'+new URLSearchParams({workspaceId:workspace,kind:'contacts',id:contactId});
  assert.equal((await request(linkedContact,{headers:rep})).status,404);
  assert.deepEqual((await read(request(scoped,{headers:rep}))).items.map(row=>row.id),[importedId]);
  assert.equal((await request(scoped+'&record='+existingId,{headers:rep})).status,404);
  assert.equal((await request(attachment+'&workspaceId='+workspace,{headers:rep})).status,404);
  await write(request,origin,owner,'/api/workspaces',{action:'revoke',id:member.id});
  assert.equal((await request(shared,{headers:rep})).status,404);
}
