import assert from 'node:assert/strict';

export async function verifyInstallAssets(request,html,check=assert.deepEqual){
  check(/rel="manifest" href="\/harbor\.webmanifest"/.test(html),true,'sign-in links the install manifest');
  check(/rel="apple-touch-icon" href="\/harbor-icon-180\.png"/.test(html),true,'sign-in links the Apple touch icon');
  const response=await request('/harbor.webmanifest');
  check(response.status,200,'signed-out install manifest is served');
  check(response.headers.get('content-type')?.split(';')[0],'application/manifest+json','manifest MIME type');
  check(response.headers.has('set-cookie'),false,'manifest creates no session');
  const manifest=await response.json();
  check([manifest.id,manifest.scope,manifest.start_url,manifest.display],['/','/','/','standalone'],
    'installation opens the normal private app entry');
  check(manifest.icons.map(({src,sizes,type})=>[src,sizes,type]),[
    ['/harbor-icon-192.png','192x192','image/png'],['/harbor-icon-512.png','512x512','image/png'],
  ],'install manifest supplies two local PNG icons');
  for(const size of [180,192,512]){
    const icon=await request('/harbor-icon-'+size+'.png');
    check(icon.status,200,'signed-out icon is served');
    check(icon.headers.get('content-type')?.split(';')[0],'image/png','icon MIME type');
    const bytes=Buffer.from(await icon.arrayBuffer());
    check(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a','PNG signature');
    check([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[size,size],'icon dimensions');
  }
}
