import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {CreateBucketCommand,PutObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {prepareWorkspaceFileRevocation} from './workspace-revocation-fixture.mjs';

export function localFileFixture(value=process.env.HARBOR_TEST_S3_ENDPOINT){
  if(!value)return null;
  const endpoint=new URL(value);
  assert.equal(endpoint.protocol,'http:');
  assert.equal(endpoint.hostname,'127.0.0.1');
  const bucket='harbor-file-test-'+randomUUID();
  const credentials={accessKeyId:'S3RVER',secretAccessKey:'S3RVER'};
  const storage=new S3Client({endpoint:endpoint.href,region:'us-east-1',forcePathStyle:true,credentials,
    requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',maxAttempts:1});
  return {bucket,storage,env:{
    HARBOR_S3_ENDPOINT:endpoint.href,HARBOR_S3_BUCKET:bucket,HARBOR_S3_ACCESS_KEY_ID:credentials.accessKeyId,
    HARBOR_S3_SECRET_ACCESS_KEY:credentials.secretAccessKey,HARBOR_S3_REGION:'us-east-1',
  }};
}

export async function verifyPortableFiles({fixture,request,origin,headers,other,record,otherRecord,sql}){
  const {bucket,storage}=fixture;
  const fileId=randomUUID(),first=randomUUID();
  const base='/api/record-attachments?recordId='+record.id;
  const library='/?view=files';
  const contactLibrary=library+'&contactId='+record.id;
  const searchLibrary=value=>library+'&'+new URLSearchParams({search:value});
  const fetchVersion=(auth,versionId)=>request(base+'&fileId='+fileId+(versionId?'&versionId='+versionId:''),{headers:auth});
  const list=auth=>request(base,{headers:auth});
  const upload=(auth,versionId,bytes,expectedVersion,site=origin,name='Café proof.txt')=>request(base+'&'+new URLSearchParams({
    fileId,versionId,...(expectedVersion?{expectedVersion}:{}),
  }),{method:'POST',headers:{...auth,origin:site,'x-harbor-file-name':encodeURIComponent(name)},body:bytes});
  const initial=Uint8Array.from([0,55,89,255,1]);
  assert.equal((await list({})).status,401);
  assert.equal((await list(other)).status,404);
  assert.equal((await upload(other,first,initial)).status,404);
  assert.equal((await upload(headers,first,initial,undefined,'https://other.example.test')).status,403);
  assert.equal((await upload(headers,first,initial)).status,502);
  assert.deepEqual(await (await list(headers)).json(),{files:[],next:null});
  assert.equal((await fetchVersion(headers,first)).status,404);
  assert.equal((await request(library)).status,307);
  assert.match(await (await request(library,{headers})).text(),/No files on this page/);
  const [stage]=await sql`SELECT revision FROM contact_file_versions WHERE file_id=${fileId} AND version_id=${first}`;
  assert.equal(stage.revision,null);

  // A staged upload from before the author column can still be retried by its owner.
  await sql`UPDATE contact_file_versions SET actor_id=NULL WHERE file_id=${fileId} AND version_id=${first}`;

  await storage.send(new CreateBucketCommand({Bucket:bucket}));
  assert.equal((await upload(headers,first,initial)).status,200);
  assert.equal((await upload(headers,first,initial)).status,200);
  assert.equal((await upload(headers,first,Uint8Array.of(12))).status,409);
  const folderApi='/api/file-folders',folderId=randomUUID(),otherFolder=randomUUID(),spareFolder=randomUUID();
  const folderView=id=>library+'&folder='+id;
  const folderWrite=(body,auth=headers,site=origin)=>request(folderApi,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const create=(id,name,parentId)=>({action:'create',id,name,parentId});
  const moveFolder=(id,expectedRevision,parentId)=>({action:'moveFolder',id,expectedRevision,parentId});
  const children=(parentId,after,auth=headers)=>request(folderApi+'?'+new URLSearchParams({
    parentId,...(after?{after}:{}),
  }),{headers:auth});
  const move=(folderId,expectedRevision,versionId)=>({action:'move',contactId:record.id,fileId,versionId,expectedRevision,folderId});
  assert.equal((await request(folderApi)).status,401);
  assert.equal((await request(folderApi,{headers,method:'DELETE'})).status,404);
  assert.equal((await folderWrite(create(folderId,'Wrong origin'),headers,'https://outside.example.test')).status,403);
  assert.equal((await folderWrite(create(folderId,'bad/name'))).status,400);
  assert.equal((await folderWrite(create(folderId,'Cafe\u0301 prospects'))).status,201);
  assert.equal((await folderWrite(create(folderId,'Café prospects'))).status,200);
  assert.equal((await folderWrite(create(randomUUID(),'CAFÉ PROSPECTS'))).status,409);
  assert.equal((await folderWrite({action:'rename',id:folderId,expectedRevision:0,name:'Café proposals'})).status,200);
  assert.equal((await folderWrite({action:'rename',id:folderId,expectedRevision:0,name:'Stale rename'})).status,409);
  assert.equal((await folderWrite(create(spareFolder,'Empty folder'))).status,201);
  assert.equal((await folderWrite(create(otherFolder,'Other private folder'),other)).status,201);
  assert.equal((await request(folderView(folderId),{headers:other})).status,404);
  assert.equal((await folderWrite(move(otherFolder,0,first))).status,404);
  assert.equal((await folderWrite(move(folderId,0,first),other)).status,404);
  assert.match(await (await request(folderView('root'),{headers})).text(),/Café proof\.txt/);
  assert.equal((await folderWrite(move(folderId,0,first))).status,200);
  assert.match(await (await request(folderView(folderId),{headers})).text(),/Café proof\.txt/);
  assert.doesNotMatch(await (await request(folderView('root'),{headers})).text(),/Café proof\.txt/);
  const original=await fetchVersion(headers,first);
  assert.equal(original.status,200);
  assert.equal(original.headers.get('cache-control'),'private, no-store');
  assert.match(original.headers.get('content-disposition'),/Caf%C3%A9%20proof\.txt/);
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()),initial);
  assert.equal((await fetchVersion(other,first)).status,404);
  assert.equal((await request('/api/record-attachments?recordId='+otherRecord.id+'&fileId='+fileId,{headers:other})).status,404);

  const replacements=[{id:randomUUID(),bytes:Uint8Array.of(2,3)},{id:randomUUID(),bytes:Uint8Array.of(4,5)}];
  const currentName='Current Café 100% proof.txt';
  const results=await Promise.all(replacements.map(version=>upload(headers,version.id,version.bytes,first,origin,currentName)));
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  const winner=replacements[results.findIndex(result=>result.ok)],loser=replacements.find(version=>version!==winner);
  assert.equal((await fetchVersion(headers,loser.id)).status,404);
  assert.equal((await upload(headers,loser.id,loser.bytes,first)).status,409);
  const filePage=await (await list(headers)).json();
  assert.deepEqual(filePage.files.map(file=>[file.id,file.versionId]),[[fileId,winner.id]]);
  assert.deepEqual(new Uint8Array(await (await fetchVersion(headers,first)).arrayBuffer()),initial);
  const historyPath=base+'&versionsFor='+fileId+'&limit=1';
  const newestHistory=await request(historyPath,{headers});
  assert.equal(newestHistory.status,200);
  assert.equal(newestHistory.headers.get('cache-control'),'private, no-store');
  const newest=await newestHistory.json();
  assert.equal(newest.next,2);
  assert.deepEqual(newest.versions.map(({id,versionId,revision})=>[id,versionId,revision]),[[fileId,winner.id,2]]);
  const earlier=await (await request(historyPath+'&beforeRevision='+newest.next,{headers})).json();
  assert.equal(earlier.next,null);
  assert.deepEqual(earlier.versions.map(({id,versionId,revision})=>[id,versionId,revision]),[[fileId,first,1]]);
  assert.equal((await request(historyPath,{headers:other})).status,404);
  assert.equal((await request(historyPath)).status,401);

  const [row]=await sql`SELECT workspace_id FROM contact_file_versions WHERE file_id=${fileId} AND version_id=${winner.id}`;
  const placements=()=>sql`SELECT folder_id,revision FROM portable_file_locations
    WHERE workspace_id=${row.workspace_id} AND contact_id=${record.id} AND file_id=${fileId}`;
  assert.deepEqual([...(await placements())],[{folder_id:folderId,revision:1}]);
  assert.equal((await folderWrite(move(spareFolder,1,first))).status,409);
  const racing=await Promise.all([folderWrite(move(spareFolder,1,winner.id)),folderWrite(move(null,1,winner.id))]);
  assert.deepEqual(racing.map(response=>response.status).sort(),[200,409]);
  const [latestPlacement]=await placements();
  assert.equal(latestPlacement.revision,2);
  if(latestPlacement.folder_id!==null)assert.equal((await folderWrite(move(null,2,winner.id))).status,200);
  const [rootPlacement]=await placements();
  assert.equal(rootPlacement.folder_id,null);
  assert.equal((await folderWrite(move(folderId,0,winner.id))).status,409);
  assert.equal((await folderWrite(move(folderId,rootPlacement.revision,winner.id))).status,200);
  assert.equal((await folderWrite({action:'remove',id:spareFolder,expectedRevision:0})).status,200);
  assert.equal((await folderWrite(create(spareFolder,'Empty folder'))).status,409);
  assert.equal((await request(folderView(spareFolder),{headers})).status,404);

  const folderIds=Array.from({length:26},()=>randomUUID());
  await sql`INSERT INTO portable_file_folders(workspace_id,id,parent_id,name,name_key)
    SELECT ${row.workspace_id},v.id,${folderId},'Folder '||v.id,'folder '||v.id FROM unnest(${folderIds}::uuid[]) v(id)`;
  try{
    const page=await (await request(folderApi,{headers})).json();
    assert.equal(page.folders.length,25);
    assert.ok(page.next);
    const last=await (await request(folderApi+'?after='+page.next,{headers})).json();
    assert.equal(last.next,null);
    assert.deepEqual([...page.folders,...last.folders].map(folder=>folder.id),[...folderIds,folderId].sort());
    const firstChildPage=await (await children(folderId)).json();
    assert.equal(firstChildPage.folders.length,25);
    assert.ok(firstChildPage.next);
    const lastChildPage=await (await children(folderId,firstChildPage.next)).json();
    assert.equal(lastChildPage.next,null);
    assert.deepEqual([...firstChildPage.folders,...lastChildPage.folders].map(folder=>folder.id),folderIds.sort());
    assert.deepEqual((await (await children('root')).json()).folders.map(folder=>folder.id),[folderId]);
    assert.equal((await children(folderId,null,other)).status,404);
    assert.deepEqual((await (await request(folderApi,{headers:other})).json()).folders.map(folder=>folder.id),[otherFolder]);
  }finally{
    await sql`DELETE FROM portable_file_folders WHERE workspace_id=${row.workspace_id} AND id=ANY(${folderIds}::uuid[])`;
  }
  assert.match(await (await request(folderView(folderId)+'&search=100%25',{headers})).text(),/Current Café 100% proof\.txt/);
  const libraryPage=await request(library,{headers});
  assert.equal(libraryPage.status,200);
  const html=await libraryPage.text();
  assert.match(html,/<h1[^>]*>Files<\/h1>/);
  assert.ok(html.includes(currentName));
  assert.ok(html.includes('fileId='+fileId+'&amp;versionId='+winner.id));
  assert.ok(!html.includes(first)&&!html.includes(loser.id));
  assert.ok(!(await (await request(library,{headers:other})).text()).includes(currentName));
  assert.equal((await request(library+'&workspaceId='+row.workspace_id,{headers:other})).status,404);
  assert.equal((await request(library+'&after=invalid',{headers})).status,404);
  assert.match(await (await request(searchLibrary('100%'),{headers})).text(),/Current Café 100% proof\.txt/);
  assert.match(await (await request(searchLibrary('Café proof'),{headers})).text(),/No matching files/);
  const contactPage=await request('/?contact='+record.id,{headers});
  assert.equal(contactPage.status,200);
  assert.ok((await contactPage.text()).includes('href="'+contactLibrary.replaceAll('&','&amp;')+'">View in Files library</a>'));
  const scoped=await request(contactLibrary+'&'+new URLSearchParams({folder:folderId,sort:'name',search:'100%'}),{headers});
  assert.equal(scoped.status,200);
  const scopedMarkup=await scoped.text();
  assert.match(scopedMarkup,/<select name="contactId">/);
  assert.ok(scopedMarkup.includes(currentName));
  assert.match(scopedMarkup,/contactId=[^"]+">Clear search<\/a>/);
  const ownRoot=await request(contactLibrary+'&folder=root',{headers});
  assert.equal(ownRoot.status,200);
  assert.match(await ownRoot.text(),/No matching files/);
  assert.equal((await request(library+'&contactId=',{headers})).status,200);
  assert.equal((await request(library+'&contactId=invalid',{headers})).status,404);
  assert.equal((await request(contactLibrary+'&contactId='+record.id,{headers})).status,404);
  for(const contactId of [otherRecord.id,randomUUID()]){
    assert.equal((await request(library+'&contactId='+contactId,{headers})).status,404);
  }
  assert.equal((await request(contactLibrary,{headers:other})).status,404);

  const synthetic=Array.from({length:27},()=>randomUUID()).sort();
  const olderVersion=randomUUID(),decoyFile=randomUUID();
  const decoyContact='00000000-0000-4000-8000-000000000001';
  await sql`INSERT INTO contact_file_versions(workspace_id,contact_id,file_id,version_id,revision,name,size,sha256,created_at)
    SELECT ${row.workspace_id},${record.id},v.id,v.id,CASE WHEN v.position=2 THEN 2 ELSE 1 END,
      CASE WHEN v.position=1 THEN 'Zebra' WHEN v.position<=3 THEN 'zebra' ELSE 'Alpha' END||' Synthetic page.txt',
      1,repeat('0',64),CASE
        WHEN v.position BETWEEN 2 AND 25 THEN '2025-01-01T00:00:00.000003Z'::timestamptz
        WHEN v.position=27 THEN '2025-01-01T00:00:00.000001Z'::timestamptz
        ELSE '2025-01-01T00:00:00.000002Z'::timestamptz END
    FROM unnest(${synthetic}::uuid[]) WITH ORDINALITY v(id,position)`;
  try{
    await sql`INSERT INTO contact_file_versions (workspace_id,contact_id,file_id,version_id,revision,name,size,sha256,created_at)
      VALUES (${row.workspace_id},${record.id},${synthetic[1]},${olderVersion},1,'A superseded Synthetic page.txt',
        1,repeat('0',64),'2090-01-01T00:00:00Z')`;
    const nextPage=markup=>markup.match(/href="([^"]+after=[^"]+)">Next page<\/a>/)?.[1]?.replaceAll('&amp;','&');
    const ids=markup=>Array.from(markup.matchAll(/fileId=([a-f0-9-]+)&amp;versionId=/g),match=>match[1]);
    const firstPage=await (await request(library,{headers})).text();
    const next=nextPage(firstPage);
    assert.ok(next);
    const legacyPosition=new URL(next,origin).searchParams.get('after');
    assert.equal(legacyPosition,record.id+':'+[...synthetic,fileId].sort()[24]);
    const secondPage=await (await request(next,{headers})).text();
    assert.equal(ids(firstPage).length,25);
    assert.equal(ids(secondPage).length,3);
    assert.deepEqual([...ids(firstPage),...ids(secondPage)],[...synthetic,fileId].sort());
    // The other Contact has the same name and eventually has a matching current file.
    await sql`INSERT INTO contacts (workspace_id,id,revision,data,created_at,updated_at)
      SELECT workspace_id,${decoyContact},1,data,created_at,updated_at FROM contacts
      WHERE workspace_id=${row.workspace_id} AND id=${record.id}`;
    const empty=await request(library+'&contactId='+decoyContact,{headers});
    assert.equal(empty.status,200);
    assert.match(await empty.text(),/No matching files/);
    await sql`INSERT INTO contact_file_versions (workspace_id,contact_id,file_id,version_id,revision,name,size,sha256,created_at)
      VALUES (${row.workspace_id},${decoyContact},${decoyFile},${decoyFile},1,'A decoy Synthetic page.txt',
        1,repeat('0',64),'2090-01-01T00:00:00Z')`;
    const decoy=await request(library+'&contactId='+decoyContact,{headers});
    assert.equal(decoy.status,200);
    assert.deepEqual(ids(await decoy.text()),[decoyFile]);
    const filteredDefault=await request(contactLibrary,{headers});
    assert.equal(filteredDefault.status,200);
    const filteredMarkup=await filteredDefault.text();
    assert.deepEqual(ids(filteredMarkup),ids(firstPage));
    assert.equal(new URL(nextPage(filteredMarkup),origin).searchParams.get('contactId'),record.id);
    assert.equal((await request(contactLibrary+'&'+new URLSearchParams({after:decoyContact+':'+decoyFile}),{headers})).status,404);
    for(const [sort,expected] of [
      ['name',[...synthetic.slice(3),...synthetic.slice(0,3)]],
      ['newest',[...synthetic.slice(1,25),synthetic[0],...synthetic.slice(25)]],
    ]){
      const scope=new URLSearchParams({sort,folder:'root',search:'Synthetic page',contactId:record.id});
      const firstSorted=await request(library+'&'+scope,{headers});
      assert.equal(firstSorted.status,200);
      const firstMarkup=await firstSorted.text();
      assert.deepEqual(ids(firstMarkup),expected.slice(0,25));
      const nextSorted=nextPage(firstMarkup);
      assert.ok(nextSorted);
      const nextQuery=new URL(nextSorted,origin).searchParams;
      const after=[sort,record.id,expected[24],expected[24]].join(':');
      assert.deepEqual(Object.fromEntries(nextQuery),{view:'files',...Object.fromEntries(scope),after});
      const last=await request(nextSorted,{headers});
      assert.equal(last.status,200);
      const lastMarkup=await last.text();
      assert.deepEqual(ids(lastMarkup),expected.slice(25));
      assert.equal(nextPage(lastMarkup),undefined);
      assert.ok(!firstMarkup.includes(olderVersion)&&!lastMarkup.includes(olderVersion));
      assert.equal((await request(nextSorted,{headers:other})).status,404);
      for(const invalid of [legacyPosition,after.replace(/^(name|newest)/,sort==='name'?'newest':'name')]){
        assert.equal((await request(library+'&'+scope+'&'+new URLSearchParams({after:invalid}),{headers})).status,404);
      }
    }
  }finally{
    await sql`DELETE FROM contact_file_versions WHERE workspace_id=${row.workspace_id} AND file_id=ANY(${[...synthetic,decoyFile]}::uuid[])`;
    await sql`DELETE FROM contacts WHERE workspace_id=${row.workspace_id} AND id=${decoyContact}`;
  }
  await sql`UPDATE contacts SET archived_at=now() WHERE workspace_id=${row.workspace_id} AND id=${record.id}`;
  try{
    assert.match(await (await request(library,{headers})).text(),/No files on this page/);
    assert.equal((await request(contactLibrary,{headers})).status,404);
    assert.equal((await fetchVersion(headers,winner.id)).status,404);
    assert.equal((await folderWrite({action:'remove',id:folderId,expectedRevision:1})).status,409);
    assert.equal((await folderWrite(move(null,999,winner.id))).status,404);
  }finally{
    await sql`UPDATE contacts SET archived_at=NULL WHERE workspace_id=${row.workspace_id} AND id=${record.id}`;
  }
  // The compiled suite packs independent write scenarios into one wall-clock minute.
  const resetOwnerFileBudgets=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
    AND subject=(SELECT owner_id FROM private_workspaces WHERE id=${row.workspace_id})`;
  await resetOwnerFileBudgets();
  const nestedId=randomUUID(),leafId=randomUUID(),branchId=randomUUID();
  assert.equal((await folderWrite(create(nestedId,'Nested proposals',otherFolder))).status,404);
  assert.equal((await folderWrite(create(nestedId,'Nested proposals',folderId),other)).status,404);
  assert.equal((await folderWrite(create(nestedId,'Nested proposals',folderId))).status,201);
  assert.equal((await folderWrite(create(nestedId,'Nested proposals',folderId))).status,200);
  assert.equal((await folderWrite(create(nestedId,'Nested proposals'))).status,409);
  assert.equal((await folderWrite(create(leafId,'Signed proposals',nestedId))).status,201);
  assert.equal((await folderWrite(create(branchId,'Alternate proposals'))).status,201);
  assert.equal((await folderWrite(moveFolder(nestedId,0,nestedId))).status,409);
  assert.equal((await folderWrite(moveFolder(nestedId,0,leafId))).status,409);
  assert.equal((await folderWrite(moveFolder(nestedId,0,otherFolder))).status,404);
  assert.equal((await folderWrite(move(nestedId,rootPlacement.revision+1,winner.id))).status,200);
  assert.equal((await folderWrite(moveFolder(nestedId,0,branchId))).status,200);
  assert.equal((await folderWrite(moveFolder(nestedId,0,folderId))).status,409);
  assert.equal((await folderWrite({action:'remove',id:branchId,expectedRevision:0})).status,409);
  assert.deepEqual((await (await children(branchId)).json()).folders.map(folder=>folder.id),[nestedId]);
  const movedLeaf=await (await request(folderView(leafId),{headers})).text();
  assert.match(movedLeaf,/Alternate proposals.*Nested proposals.*Signed proposals/);
  assert.doesNotMatch(movedLeaf,/Café proposals/);
  assert.match(await (await request(folderView(nestedId),{headers})).text(),/Current Café 100% proof\.txt/);
  assert.equal((await folderWrite(moveFolder(nestedId,1,folderId))).status,200);
  assert.deepEqual((await (await children(folderId)).json()).folders.map(folder=>folder.id),[nestedId]);
  assert.equal((await folderWrite({action:'remove',id:branchId,expectedRevision:0})).status,200);
  assert.match(await (await request(folderView(nestedId),{headers})).text(),/Café proposals.*Nested proposals/);

  const raceA=randomUUID(),raceB=randomUUID();
  assert.equal((await folderWrite(create(raceA,'Folder move race A'))).status,201);
  assert.equal((await folderWrite(create(raceB,'Folder move race B'))).status,201);
  const moves=await Promise.all([folderWrite(moveFolder(raceA,0,raceB)),folderWrite(moveFolder(raceB,0,raceA))]);
  assert.deepEqual(moves.map(response=>response.status).sort(),[200,409]);

  const chain=Array.from({length:31},()=>randomUUID()),depth32=randomUUID();
  await sql`INSERT INTO portable_file_folders(workspace_id,id,parent_id,name,name_key)
    SELECT ${row.workspace_id},v.id,v.parent,'Depth '||v.level,'depth '||v.level
    FROM unnest(${chain}::uuid[],${[null,...chain.slice(0,-1)]}::uuid[]) WITH ORDINALITY v(id,parent,level)`;
  try{
    assert.equal((await folderWrite(create(depth32,'Last supported folder',chain.at(-1)))).status,201);
    assert.equal((await folderWrite(create(randomUUID(),'Too deep',depth32))).status,409);
    assert.equal((await folderWrite(moveFolder(nestedId,2,chain.at(-1)))).status,409);
    assert.equal((await request(folderView(depth32),{headers})).status,200);
  }finally{
    await sql`DELETE FROM portable_file_folders WHERE workspace_id=${row.workspace_id}
      AND id=ANY(${[...chain,depth32]}::uuid[])`;
  }

  const key=['contact-files',row.workspace_id,record.id,fileId,winner.id].join('/');
  try{
    await storage.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:Uint8Array.of(8,9)}));
    assert.equal((await fetchVersion(headers)).status,502);
  }finally{
    await storage.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:winner.bytes}));
  }
  await resetOwnerFileBudgets();
  return async ()=>{
    const current=await fetchVersion(headers);
    assert.equal(current.status,200);
    assert.deepEqual(new Uint8Array(await current.arrayBuffer()),winner.bytes);
    assert.equal((await fetchVersion(other)).status,404);
    assert.match(await (await request(folderView(nestedId),{headers})).text(),/Current Café 100% proof\.txt/);
  };
}


export async function verifyPortableSharedFiles({request,origin,headers,other,record,workspaceId,change,activeEditor,sql}){
  const owned='/api/record-attachments?recordId='+record.id;
  const shared=owned+'&workspaceId='+workspaceId;
  const list=async(path,auth)=>request(path,{headers:auth});
  const fileId=randomUUID(),versionId=randomUUID(),bytes=Uint8Array.of(42,17);
  const upload=(grantId,file,version,expectedVersion)=>request(shared+'&'+new URLSearchParams({
    grantId,fileId:file,versionId:version,...(expectedVersion?{expectedVersion}:{}),
  }),{method:'POST',headers:{...other,origin,'x-harbor-file-name':'Shared%20proof.txt'},body:bytes});
  const update=async(action,id,fields)=>{
    const response=await change(headers,{action,id,...fields});
    assert.equal(response.status,200);
    return (await response.json()).viewers[0];
  };

  assert.equal(activeEditor.contactFiles,false);
  assert.equal((await list(shared,other)).status,404);
  assert.equal((await upload(activeEditor.id,fileId,versionId)).status,403);
  assert.equal((await change(other,{action:'contact_files',id:activeEditor.id,enabled:true})).status,404);
  const editor=await update('contact_files',activeEditor.id,{enabled:true});
  assert.notEqual(editor.id,activeEditor.id);
  assert.equal(editor.contactFiles,true);
  assert.equal((await list(shared,{})).status,401);
  assert.equal((await list(shared,other)).status,200);
  assert.equal((await list(owned,other)).status,404);
  const sharedContact=await request('/?'+new URLSearchParams({contact:record.id,workspaceId}),{headers:other});
  assert.equal(sharedContact.status,200);
  const sharedContactMarkup=await sharedContact.text();
  assert.match(sharedContactMarkup,/<h2>Contact files<\/h2>/);
  const library='/?'+new URLSearchParams({view:'files',contactId:record.id,workspaceId});
  assert.deepEqual([...sharedContactMarkup.matchAll(/href="([^"]+)">View in Files library<\/a>/g)].map(match=>match[1].replaceAll('&amp;','&')),[library]);
  assert.equal((await list(library,other)).status,200);
  assert.equal((await upload(activeEditor.id,fileId,versionId)).status,403);
  assert.equal((await upload(editor.id,fileId,versionId)).status,200);
  assert.equal((await upload(editor.id,fileId,versionId)).status,200);
  const replacement=randomUUID();
  assert.equal((await upload(editor.id,fileId,replacement,versionId)).status,200);
  const path='&fileId='+fileId+'&versionId='+replacement;
  const ownerFile=await list(owned+path,headers);
  assert.equal(ownerFile.status,200);
  assert.deepEqual(new Uint8Array(await ownerFile.arrayBuffer()),bytes);
  const history=await sql`SELECT v.version_id,v.revision,i.email FROM contact_file_versions v
    JOIN login_identities i ON i.id=v.actor_id WHERE v.file_id=${fileId} ORDER BY v.revision`;
  assert.deepEqual(history.map(row=>[row.version_id,row.revision,row.email]),
    [[versionId,1,'other@example.test'],[replacement,2,'other@example.test']]);

  const viewer=await update('role',editor.id,{role:'viewer'});
  const viewerFile=await list(shared+path,other);
  assert.equal(viewerFile.status,200);
  assert.equal(viewerFile.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(new Uint8Array(await viewerFile.arrayBuffer()),bytes);
  assert.equal((await upload(viewer.id,randomUUID(),randomUUID())).status,403);

  const racingEditor=await update('role',viewer.id,{role:'editor'});
  const interruptedVersion=randomUUID();
  let pendingUpload,pendingRevoke;
  async function waitForLock(blocker,fragment){
    for(let i=0;i<80;i++){
      const [waiting]=await sql`SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND ${blocker}::int=ANY(pg_blocking_pids(pid)) AND query LIKE ${fragment}`;
      if(waiting)return waiting.pid;
      await delay(25);
    }
    assert.fail('Expected a pending row lock for '+fragment);
  }
  await sql.begin(async tx=>{
    // Hold registration on the contact row while a revocation queues behind its grant lock.
    const [{pid}]=await tx`SELECT pg_backend_pid() AS pid FROM contacts WHERE workspace_id=${workspaceId} AND id=${record.id} FOR UPDATE`;
    pendingUpload=upload(racingEditor.id,fileId,interruptedVersion,replacement);
    const uploader=await waitForLock(pid,'%from "contacts"%');
    pendingRevoke=update('contact_files',racingEditor.id,{enabled:false});
    await waitForLock(uploader,'%update "portable_workspace_viewers"%');
  });
  assert.equal((await pendingUpload).status,403);
  const disabled=await pendingRevoke;
  const [pending]=await sql`SELECT revision FROM contact_file_versions WHERE version_id=${interruptedVersion}`;
  assert.equal(pending.revision,null);
  assert.equal((await list(shared+path,other)).status,404);
  assert.equal((await list(owned+'&fileId='+fileId+'&versionId='+interruptedVersion,headers)).status,404);
  assert.equal((await list(owned+path,headers)).status,200);
  const reenabled=await update('contact_files',disabled.id,{enabled:true});

  const archivedVersion=randomUUID();
  let stagedUpload,archive;
  try{
    await sql.begin(async tx=>{
      // Registration takes the Contact lock first. Archive queues behind it and commits before publication.
      const [{pid}]=await tx`SELECT pg_backend_pid() AS pid FROM contacts WHERE workspace_id=${workspaceId} AND id=${record.id} FOR UPDATE`;
      stagedUpload=upload(reenabled.id,fileId,archivedVersion,replacement);
      const uploader=await waitForLock(pid,'%from "contacts"%');
      archive=sql`UPDATE /* fixture file archive */ contacts SET archived_at=now()
        WHERE workspace_id=${workspaceId} AND id=${record.id}`.execute();
      await waitForLock(uploader,'%UPDATE /* fixture file archive */ contacts%');
    });
    const [denied]=await Promise.all([stagedUpload,archive]);
    assert.equal(denied.status,404);
    const [stillStaged]=await sql`SELECT revision FROM contact_file_versions WHERE version_id=${archivedVersion}`;
    assert.equal(stillStaged.revision,null);
    const blockedVersion=randomUUID();
    assert.equal((await upload(reenabled.id,fileId,blockedVersion,replacement)).status,404);
    assert.equal((await sql`SELECT 1 FROM contact_file_versions WHERE version_id=${blockedVersion}`).length,0);
    assert.equal((await list(owned+path,{})).status,401);
    assert.equal((await list(owned+path,other)).status,404);
    assert.equal((await list(owned+path,headers)).status,404);
    assert.equal((await list(shared+path,other)).status,404);
  }finally{
    await Promise.allSettled([stagedUpload,archive]);
    await sql`UPDATE contacts SET archived_at=NULL WHERE workspace_id=${workspaceId} AND id=${record.id}`;
  }
  for(const prior of [versionId,replacement]){
    const preserved=await list(owned+'&fileId='+fileId+'&versionId='+prior,headers);
    assert.equal(preserved.status,200);
    assert.deepEqual(new Uint8Array(await preserved.arrayBuffer()),bytes);
  }
  assert.equal((await list(owned+'&fileId='+fileId+'&versionId='+archivedVersion,headers)).status,404);
  const verifyRevokedAttachment=await prepareWorkspaceFileRevocation({
    readMember:()=>list(shared+path,other),readOwner:()=>list(owned+path,headers),bytes,
  });
  assert.equal((await change(headers,{action:'revoke',id:reenabled.id})).status,200);
  await verifyRevokedAttachment();
  const restoredViewer=await update('grant',undefined,{email:'other@example.test'});
  const restoredEditor=await update('role',restoredViewer.id,{role:'editor'});
  return (await update('contact_files',restoredEditor.id,{enabled:true})).id;
}
