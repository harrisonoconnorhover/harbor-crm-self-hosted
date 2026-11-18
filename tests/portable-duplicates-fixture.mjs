import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const crm='/api/crm',path='/api/duplicates';

export async function verifyPortableDuplicates({request,origin,headers,other,sql,sharing}){
  const workspaceId=sharing.workspaceId;
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const send=(target,body,auth=headers,site=origin)=>request(target,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const save=async body=>{
    const response=await send(crm,{action:'save',...body});
    assert.equal(response.status,201,await response.clone().text());
    return (await response.json()).record;
  };
  const list=async(query,auth=headers)=>{
    const response=await request(path+'?'+new URLSearchParams(query),{headers:auth});
    assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    return response.json();
  };
  const marker='Dupe'+randomUUID().slice(0,8);
  const email=marker.toLowerCase()+'@example.test';
  const sameEmail=[await save({kind:'contacts',data:{name:marker+' Ada',email}}),await save({kind:'contacts',data:{name:marker+' Ada Byron',email:email.toUpperCase()}})];
  const sameName=[await save({kind:'contacts',data:{name:marker+' Grace Hopper'}}),await save({kind:'contacts',data:{name:marker+' Grace Hopper'}})];
  const domain=marker.toLowerCase()+'.example.test';
  const companies=[await save({kind:'companies',data:{name:marker+' Fictional Inc',domain}}),await save({kind:'companies',data:{name:marker+' Other',domain:'https://www.'+domain+'/'}})];
  const ids=pair=>[pair.left.id,pair.right.id].sort().join(':');
  const key=rows=>rows.map(row=>row.id).sort().join(':');

  assert.equal((await request(path)).status,401);
  assert.equal((await list({kind:'contacts',query:marker},other)).total,0,'the member sees only their own workspace');
  let contacts=await list({kind:'contacts',query:marker});
  const byKey=new Map(contacts.pairs.map(pair=>[ids(pair),pair]));
  assert.deepEqual([byKey.get(key(sameEmail))?.score,byKey.get(key(sameEmail))?.reasons],[100,['Same email address']]);
  assert.deepEqual(byKey.get(key(sameName))?.reasons,['Same full name']);
  assert.equal(byKey.get(key(sameEmail)).left.revision,1);
  assert.equal((await list({kind:'contacts',query:marker,strength:'strong'})).pairs.some(pair=>ids(pair)===key(sameName)),false);
  const company=(await list({kind:'companies',query:marker})).pairs.find(pair=>ids(pair)===key(companies));
  assert.deepEqual(company?.reasons,['Same company domain']);

  // Dismiss and restore a pair; both need two active records of the kind.
  const dismiss={action:'dismiss',kind:'contacts',recordA:sameName[1].id,recordB:sameName[0].id};
  assert.equal((await send(path,dismiss,headers,'https://outside.example.test')).status,403);
  assert.equal((await send(path,{...dismiss,kind:'companies'})).status,404);
  assert.equal((await send(path,dismiss,other)).status,404);
  assert.equal((await send(path,dismiss)).status,200);
  assert.equal((await send(path,dismiss)).status,200,'dismissing twice is harmless');
  contacts=await list({kind:'contacts',query:marker});
  assert.ok(!contacts.pairs.some(pair=>ids(pair)===key(sameName)));
  const dismissed=await list({kind:'contacts',query:marker,status:'dismissed'});
  assert.deepEqual(dismissed.pairs.map(ids),[key(sameName)]);
  assert.ok(dismissed.pairs[0].dismissedAt);
  assert.equal((await send(path,{...dismiss,action:'restore'})).status,200);
  assert.ok((await list({kind:'contacts',query:marker})).pairs.some(pair=>ids(pair)===key(sameName)));

  // Shared editors review through their grant; merging a pair removes it.
  const scope={workspaceId,grantId:sharing.grantId};
  assert.equal((await request(path+'?'+new URLSearchParams({kind:'contacts',workspaceId,grantId:randomUUID()}),{headers:other})).status,403);
  assert.ok((await list({kind:'contacts',query:marker,...scope},other)).pairs.some(pair=>ids(pair)===key(sameEmail)));
  const [grant]=await sql`SELECT contact_files,scheduled_notes,contact_outreach,record_activities FROM portable_workspace_viewers WHERE id=${sharing.grantId}`;
  await sql`UPDATE portable_workspace_viewers SET contact_files=true,scheduled_notes=true,contact_outreach=true,record_activities=true
    WHERE id=${sharing.grantId}`;
  try{
    const merge='/api/record-merge?'+new URLSearchParams(scope);
    const review=await send(merge,{action:'preview',kind:'contacts',primaryId:sameEmail[0].id,secondaryId:sameEmail[1].id},other);
    assert.equal(review.status,200,await review.clone().text());
    const {preview}=await review.json();
    assert.equal((await send(merge,{action:'merge',kind:'contacts',primaryId:preview.primary.id,secondaryId:preview.secondary.id,
      requestId:randomUUID(),expectedRevisions:{primary:preview.primary.revision,secondary:preview.secondary.revision},choices:{}},other)).status,200);
  }finally{
    await sql`UPDATE portable_workspace_viewers SET contact_files=${grant.contact_files},scheduled_notes=${grant.scheduled_notes},
      contact_outreach=${grant.contact_outreach},record_activities=${grant.record_activities} WHERE id=${sharing.grantId}`;
  }
  assert.ok(!(await list({kind:'contacts',query:marker})).pairs.some(pair=>ids(pair)===key(sameEmail)));

  const page=await (await request('/?'+new URLSearchParams({view:'duplicates',kind:'companies'}),{headers})).text();
  assert.match(page,/Manage duplicates/);
  assert.match(await (await request('/?kind=companies',{headers})).text(),/view=duplicates&amp;kind=companies/);
  await sql`DELETE FROM portable_duplicate_dismissals WHERE workspace_id=${workspaceId}`;
  await reset();
}
