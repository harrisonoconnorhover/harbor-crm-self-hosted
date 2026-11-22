import assert from 'node:assert/strict';

export async function verifyPortableSettingsNavigation({request,headers,other,workspaceId}){
  async function page(path,auth=headers){
    const response=await request(path,{headers:auth});
    assert.equal(response.status,200,path);
    return (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replaceAll('<!-- -->','');
  }
  const properties='/?view=settings&section=properties&kind=companies',pipeline='/?view=settings&section=pipelines';
  const linkId=crypto.randomUUID();
  for(const bookmark of [properties,'/?view=workspaces&workspaceId='+workspaceId,'/?view=invoices&q=North+%26+South&status=open&dueFrom=2026-11-01&after='+linkId,
    '/?view=invoices&invoiceId='+linkId+'&before=4&paymentsBefore=3',
    '/quotes?id='+linkId+'&before=4&versionBefore=3','/?view=landing-pages&edit='+linkId,'/?view=landing-pages&after='+linkId,
    '/?view=record-access&token='+linkId,'/?view=record-access&event='+linkId]){
    const login=await request(bookmark);
    assert.equal(login.status,307,bookmark);
    assert.equal(new URL(login.headers.get('location'),'http://localhost').searchParams.get('return_to'),bookmark);
  }
  const overview=await page('/?view=settings');
  for(const [name,path] of [['Data management','/?view=settings&amp;section=data-management'],['API access','/?view=api-access'],
    ['Job queue','/?view=job-queue'],['Getting started','/?view=getting-started']]){
    assert.ok(overview.includes('href="'+path+'"'),name+' link');
  }
  assert.match(await page(properties),/<details[^>]*open[^>]*><summary>Manage properties<\/summary>/);
  assert.match(await page(pipeline),/class="portable-pipeline-settings"[^>]*open[^>]*>/);
  assert.match(await page('/?view=settings&section=objects'),/Deal pipelines/);
  const data=await page('/?view=settings&section=data-management');
  assert.ok(data.includes('/?view=import')&&data.includes('/?view=duplicates'));
  const integrations='/?view=settings&section=integrations';
  const hub=await page(integrations);
  assert.match(hub,/<h1>Integrations<\/h1>/);
  assert.ok(hub.includes('href="/?view=api-access"'));
  for(const kind of ['contacts','companies','deals','paired']){
    const html=await page('/?view=import&kind='+kind);
    assert.match(html,/<details[^>]*open[^>]*><summary>Import /);
    assert.match(html,/type="file"/);
  }
  for(const id of ['api-access','job-queue','getting-started']){
    const html=await page('/?view='+id);
    assert.match(html,/aria-label="Settings navigation"/);
  }
  const scope='&workspaceId='+workspaceId;
  const shared=await page('/?view=settings'+scope,other);
  assert.match(shared,/Your workspace access/);
  assert.doesNotMatch(shared,/href="\/\?view=(job-queue|api-access|import|getting-started)"/);
  for(const path of [properties,pipeline,integrations,'/?view=settings&section=data-management','/?view=import','/?view=job-queue','/?view=api-access','/?view=getting-started']){
    assert.equal((await request(path+scope,{headers:other})).status,404,path);
  }
  assert.equal((await request('/?view=settings&workspaceId=00000000-0000-4000-8000-000000000000',{headers:other})).status,404);
}
