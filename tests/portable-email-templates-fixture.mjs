import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyPortableEmailTemplates({request,origin,headers,other,sql,workspaceId,contact,withoutEmail,foreignContact}){
  const endpoint='/api/email/templates';
  const read=(query='',auth=headers)=>request(endpoint+query,{headers:auth});
  const write=(method,body,auth=headers,site=origin)=>request(endpoint,{method,
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
    AND subject=(SELECT owner_id FROM private_workspaces WHERE id=${workspaceId})`;
  const countJobs=async()=>(await sql`SELECT count(*)::int AS count FROM portable_scheduled_gmail WHERE workspace_id=${workspaceId}`)[0].count;
  await reset();
  const before=await countJobs();
  const id=randomUUID(),removed=randomUUID();
  const preview=(templateId,contactId,auth=headers)=>read('?'+new URLSearchParams({id:templateId,contactId}),auth);
  const initial={id,name:'Café 100% follow-up',subject:'Hello {{contact.name}}',body:'First line.\nPlain <b>second</b> line.\n{{record.email|no email}}\n{{sender.name}}'};
  assert.equal((await read('',{})).status,401);
  assert.equal((await write('PUT',initial,headers,'https://outside.example.test')).status,403);
  assert.equal((await write('POST',initial)).status,404);
  assert.equal((await write('PUT',{...initial,subject:'Unresolved {{first_name}}'})).status,400);
  assert.equal((await write('PUT',{...initial,subject:'Injected\nSubject'})).status,400);
  const created=await write('PUT',initial);
  assert.equal(created.status,201);
  assert.deepEqual(await created.json(),{template:{...initial,revision:0}});
  assert.equal((await write('PUT',initial)).status,200);
  assert.equal((await write('PUT',{...initial,body:'Different retry'})).status,409);
  assert.equal((await write('PUT',{...initial,body:'Unsupported {{company.name}}'})).status,400);
  assert.equal((await write('PUT',{...initial,body:'Malformed {{record.email'})).status,400);
  const current=await preview(id,contact.id);
  assert.equal(current.status,200);
  assert.deepEqual(await current.json(),{template:{...initial,revision:0,subject:'Hello '+contact.data.name,
    body:'First line.\nPlain <b>second</b> line.\n'+(contact.data.email||'no email')+'\nHarbor Fixture'},missing:[]});
  const fallback=await (await preview(id,withoutEmail.id)).json();
  assert.equal(fallback.template.body,'First line.\nPlain <b>second</b> line.\nno email\nHarbor Fixture');
  assert.deepEqual(fallback.missing,[]);
  assert.equal((await preview(id,foreignContact.id)).status,404);
  assert.equal((await preview(id,contact.id,other)).status,404);
  await sql`UPDATE contacts SET archived_at=now() WHERE workspace_id=${workspaceId} AND id=${contact.id}`;
  try{assert.equal((await preview(id,contact.id)).status,404);}
  finally{await sql`UPDATE contacts SET archived_at=NULL WHERE workspace_id=${workspaceId} AND id=${contact.id}`;}
  assert.equal((await read('?id='+id,other)).status,404);
  assert.equal((await write('PUT',{...initial,expectedRevision:0},other)).status,404);
  assert.equal((await write('DELETE',{id,expectedRevision:0},other)).status,404);
  assert.equal((await read('?id='+id+'&workspaceId='+workspaceId,other)).status,400);
  const list=await read('?search=100%25');
  assert.equal(list.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(await list.json(),{items:[{id,name:initial.name,revision:0}],next:null});
  assert.deepEqual(await (await read('?search=100_')).json(),{items:[],next:null});
  assert.deepEqual(await (await read('',other)).json(),{items:[],next:null});
  const update={...initial,body:'Edited literal draft.',expectedRevision:0};
  const racing=await Promise.all([write('PUT',update),write('PUT',{...update,body:'Other draft edit.'})]);
  assert.deepEqual(racing.map(response=>response.status).sort(),[200,409]);
  const {template}=await racing.find(response=>response.ok).json();
  assert.equal(template.revision,1);
  assert.deepEqual(await (await read('?id='+id)).json(),{template});
  assert.equal((await write('DELETE',{id,expectedRevision:0})).status,409);
  const missingValue={...initial,id:removed,name:'Remove this fictional template',body:'Required {{record.email}}'};
  assert.equal((await write('PUT',missingValue)).status,201);
  const missingPreview=await (await preview(removed,withoutEmail.id)).json();
  assert.deepEqual(missingPreview.missing,['record.email']);
  assert.equal(missingPreview.template.body,'Required {{record.email}}');
  const deletion={id:removed,expectedRevision:0};
  assert.equal((await write('DELETE',deletion)).status,200);
  assert.equal((await write('DELETE',deletion)).status,200);
  assert.equal((await read('?id='+removed)).status,404);
  assert.equal((await write('PUT',{...initial,id:removed})).status,409);
  const [cleared]=await sql`SELECT name,subject,body FROM portable_email_templates WHERE id=${removed}`;
  assert.deepEqual(cleared,{name:'',subject:'',body:''});

  const ids=Array.from({length:26},()=>randomUUID());
  await sql`INSERT INTO portable_email_templates(workspace_id,id,name,subject,body)
    SELECT ${workspaceId},v.id,'Synthetic page '||v.id,'Subject','Body' FROM unnest(${ids}::uuid[]) v(id)`;
  try{
    const first=await (await read()).json();
    assert.equal(first.items.length,25);
    const last=await (await read('?after='+first.next)).json();
    assert.equal(last.items.length,2);
    assert.deepEqual([...first.items,...last.items].map(row=>row.id),[...ids,id].sort());
    assert.equal(last.next,null);
  }finally{
    await sql`DELETE FROM portable_email_templates WHERE workspace_id=${workspaceId} AND id=ANY(${ids}::uuid[])`;
  }
  const settings=await request('/?view=email-settings',{headers});
  assert.equal(settings.status,200);
  assert.match(await settings.text(),/Email templates/);
  assert.equal(await countJobs(),before,'Template CRUD never creates scheduled email jobs.');
  await reset();
  return {template,removed};
}
