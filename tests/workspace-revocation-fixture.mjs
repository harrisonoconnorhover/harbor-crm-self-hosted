import assert from 'node:assert/strict';

export async function prepareWorkspaceFileRevocation({readMember,readOwner,bytes,check=assert.deepEqual}){
  async function expectFile(read,label){
    const response=await read();
    check(response.status,200,label);
    check(response.headers.get('cache-control'),'private, no-store',label+' uses a private response');
    check(new Uint8Array(await response.arrayBuffer()),bytes,label+' returns the expected bytes');
  }
  await expectFile(readMember,'member can download the exact shared attachment before removal');
  return async()=>{
    const response=await readMember();
    check(response.status,404,'same session loses the exact shared attachment download after removal');
    check(response.headers.get('cache-control')?.split(',').map(value=>value.trim()).includes('no-store'),true,
      'a revoked attachment response is not cacheable');
    check(response.headers.get('content-disposition'),null,'revoked file response contains no attachment');
    const body=await response.json();
    check(Object.keys(body),['error'],'a revoked attachment response contains only an error');
    check(typeof body.error,'string','a revoked attachment response contains no file payload');
    await expectFile(readOwner,'owner keeps access to the attachment');
  };
}

// The adapters reuse their authenticated member across the revocation boundary.
export async function verifyWorkspaceRevocation({
  targetId,editedName,personalId,readShared,readOwner,readPersonal,prepareWrite,revoke,
  snapshot,deniedWriteStatus,check=assert.deepEqual,
}){
  async function readRecord(request,label){
    const response=await request();
    check(response.status,200,label);
    return response.json();
  }

  const shared=await readRecord(readShared,'editor reads the direct record after saving');
  const before=snapshot(shared);
  check([before.id,before.name],[targetId,editedName],'authorized edit is visible in the shared workspace');
  const personal=snapshot(await readRecord(readPersonal,'member can read their own record before revocation'));
  check(personal.id,personalId,'personal access reaches the unrelated record');
  // Capture a fresh write before removal so a conflict with a stale record
  // version cannot account for the post-removal denial.
  const submit=await prepareWrite(shared,'Revoked editor must not save this');

  check((await revoke()).status,200,'owner removes the editor');
  const denied=await readShared();
  check(denied.status,404,'the same session loses the direct shared read');
  check(denied.headers.get('cache-control')?.split(',').map(value=>value.trim()).includes('no-store'),true,
    'a revoked record response is not cacheable');
  check(Object.keys(await denied.json()),['error'],'a revoked record response contains only an error');
  check((await submit()).status,deniedWriteStatus,'the same session loses the prepared shared write');
  check(snapshot(await readRecord(readOwner,'owner still reads the shared record')),before,
    'the denied write preserves the record value and version');
  check(snapshot(await readRecord(readPersonal,'the same session keeps personal access')),personal,
    'revoking one workspace preserves the unrelated personal record');

  return async ({prepareFreshWrite,regrantedWriteStatus,freshName})=>{
    const reinstated=await readRecord(readShared,'the same session can read again after editor access is restored');
    check(snapshot(reinstated),before,'reinstatement leaves the record version unchanged');
    check((await submit()).status,regrantedWriteStatus,'a draft from the removed editor grant stays invalid after reinstatement');
    check(snapshot(await readRecord(readOwner,'owner reads after the old draft was rejected')),before,
      'rejecting the old draft preserves its current value and version');
    const freshSubmit=await prepareFreshWrite(reinstated,freshName);
    check((await freshSubmit()).status,200,'the same session can save from a fresh form');
    const saved=snapshot(await readRecord(readOwner,'owner can read the fresh edit'));
    check([saved.id,saved.name],[targetId,freshName],'the fresh edit is visible in the shared workspace');
    check(saved.version!==before.version,true,'the fresh edit advances the record version');
    check(snapshot(await readRecord(readPersonal,'the same session keeps personal access after regrant')),personal,
      'the restored grant only affects the shared workspace');
  };
}
