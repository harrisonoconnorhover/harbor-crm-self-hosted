import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DomUtils,parseDocument } from 'htmlparser2';
import { publicPilotContact,readPublicPilotContact } from '../lib/public-pilot-contact.mjs';

export async function checkStandalone(value, fetcher = fetch, expectedBuild, {portable = false,expectedContact,expectedGoogleClientId,checkOAuthGuards = false,checkWriteDenials = false,checkUnsubscribe = false,checkPublicDenials = false,checkInstall = false,publicFormId,expectedEmbedOrigin,beforeGoogle = false,checkReadiness = false,checkReleaseReadiness = false} = {}) {
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('Provide the exact HTTPS Harbor origin, with no path or credentials.');
  }
  if (beforeGoogle && checkOAuthGuards) throw Error('The before-Google check applies to a new install without the OAuth guard check.');
  if (checkWriteDenials && beforeGoogle) throw Error('The write-denial check requires configured sign-in.');
  if (beforeGoogle && checkUnsubscribe) throw Error('The unsubscribe check applies after sign-in setup.');
  if (checkPublicDenials && beforeGoogle) throw Error('Public denial checks require configured sign-in.');
  if (publicFormId!==undefined && (!portable||beforeGoogle||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(publicFormId))) {
    throw Error('Provide the enabled fictional form UUID for a configured portable Harbor app.');
  }
  if(expectedEmbedOrigin!==undefined&&(!publicFormId||
    !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(expectedEmbedOrigin)||
    URL.parse(expectedEmbedOrigin)?.origin!==expectedEmbedOrigin)){
    throw Error('Provide the exact HTTPS embed origin with --public-form, without a trailing slash.');
  }
  if (expectedGoogleClientId !== undefined && (beforeGoogle || typeof expectedGoogleClientId !== 'string' ||
      !/^[A-Za-z0-9._-]{1,253}$/.test(expectedGoogleClientId))) {
    throw Error('Provide the expected Google OAuth client ID only when checking configured sign-in.');
  }
  if (expectedBuild !== undefined && !/^[a-f0-9]{64}$/.test(expectedBuild)) {
    throw Error(portable?'Provide the 64-character fingerprint from the portable release image.':'Provide the build fingerprint from configure:standalone --check.');
  }
  if(checkReleaseReadiness&&!expectedBuild)throw Error('--check-release-readiness requires --expect-build.');
  const expectNoContact=expectedContact===false;
  const contact=publicPilotContact(expectedContact);
  if(expectedContact!==undefined&&!expectNoContact&&!contact)throw Error('Provide a valid expected public operator name and mailbox, or false to verify removal.');
  const origin = url.origin;
  const request = (path, headers, method, body) => fetcher(origin + path, {
    headers, method, body, redirect:'manual', credentials:'omit', signal:AbortSignal.timeout(8000),
  });
  const location = response => URL.parse(response.headers.get('location') || '/', origin);
  const redirectsToSignIn = response => {
    const next = location(response);
    return [302, 303, 307].includes(response.status) && next?.origin === origin && next.pathname === '/auth/sign-in';
  };
  const noStore = response => (response.headers.get('cache-control') ?? '').split(',').some(value => value.trim().toLowerCase() === 'no-store');
  const privateAttempt = response => {
    const cookies = response.headers.getSetCookie();
    if (cookies.length !== 1) return false;
    const [cookie, ...attributes] = cookies[0].split(';').map(value => value.trim());
    const flags = attributes.map(value => value.toLowerCase());
    const names = flags.map(flag => flag.split('=')[0].trim());
    return /^__Host-harbor-attempt=[A-Za-z0-9_.-]{1,3800}$/.test(cookie) &&
      ['path=/','httponly','secure','samesite=lax','max-age=600'].every(flag => flags.includes(flag)) &&
      !names.includes('domain') && new Set(names).size === names.length &&
      noStore(response) && response.headers.get('referrer-policy') === 'no-referrer';
  };
  const identityOnly = response => {
    const next = location(response);
    if(!next)return false;
    const params = next.searchParams;
    const scopes = params.get('scope')?.split(/\s+/).sort().join(' ');
    return response.status === 303 && next.origin === 'https://accounts.google.com' &&
      next.pathname === '/o/oauth2/v2/auth' && scopes === 'email openid profile' &&
      params.get('redirect_uri') === origin + '/auth/google/callback' && params.get('code_challenge_method') === 'S256' &&
      params.get('response_type') === 'code' && !!params.get('client_id') &&
      ['redirect_uri','response_type','client_id','scope','code_challenge_method','state','nonce','code_challenge']
        .every(name => params.getAll(name).length === 1) &&
      ['state','nonce','code_challenge'].every(name => /^[A-Za-z0-9_-]{43}$/.test(params.get(name) ?? '')) &&
      privateAttempt(response);
  };
  const googleClientMatches = response => expectedGoogleClientId === undefined ||
    location(response)?.searchParams.get('client_id') === expectedGoogleClientId;
  const page = title => async response => response.status === 200 && (await response.text()).includes(title);
  const notice = title => async response => {
    if(!contact&&!expectNoContact)return page(title)(response);
    if(response.status!==200||!noStore(response)||response.headers.has('set-cookie')||
       response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='text/html')return false;
    const html=await response.text();
    if(html.length>262_144)return false;
    const document=parseDocument(html);
    const heading=DomUtils.findOne(node=>node.name==='h1',document.children);
    if(!heading||DomUtils.textContent(heading).trim()!==title)return false;
    const sections=DomUtils.findAll(node=>node.attribs.class?.split(/\s+/).includes('trial-document-contact'),document.children);
    if(!contact)return sections.length===0;
    if(sections.length!==1||sections[0].name!=='div')return false;
    const [section]=sections;
    for(let node=section;node&&'attribs' in node;node=node.parent){
      if('hidden' in node.attribs||node.attribs['aria-hidden']==='true')return false;
    }
    const links=DomUtils.findAll(node=>node.name==='a',section.children);
    const name=section.children.filter(node=>node.type==='text').map(node=>node.data).join('').trim();
    return name===contact.name&&links.length===1&&links[0].attribs.href==='mailto:'+contact.email&&
      DomUtils.textContent(links[0]).trim()===contact.email;
  };
  const noticeHint=expectNoContact?'Check that this uncached public notice omits the installation contact.':
    contact?'Check that the intended operator name and mailbox appear on this uncached public notice.':undefined;
  const signInDestination = destination => page(`href="/auth/google/start?return_to=${encodeURIComponent(destination)}"`);
  const browserAssets = async (response, status = 200) => {
    if (response.status !== status) return false;
    const html = await response.text();
    const paths = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[a-zA-Z0-9_./-]+\.(?:js|css))"/g)].map(match => match[1]))];
    if (paths.length > 64 || !paths.some(p => p.endsWith('.js')) || !paths.some(p => p.endsWith('.css')) ||
        paths.some(path => new URL(path,origin).pathname !== path)) return false;
    for (let offset = 0; offset < paths.length; offset += 4) {
      const available = await Promise.all(paths.slice(offset, offset + 4).map(async path => {
        const asset = await request(path);
        const expected = path.endsWith('.js') ? /^(?:application|text)\/(?:x-)?javascript$/i : /^text\/css$/i;
        if (!asset.body) return false;
        if (asset.status !== 200 || !expected.test((asset.headers.get('content-type') || '').split(';')[0].trim())) {
          await asset.body.cancel();
          return false;
        }
        const reader = asset.body.getReader();
        try { return (await reader.read()).value?.length > 0; }
        finally { await reader.cancel(); }
      }));
      if (!available.every(Boolean)) return false;
    }
    return true;
  };
  const denied = async response => {
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (response.status !== 401 || !noStore(response) || type !== 'application/json') return false;
    const body = await response.json();
    return typeof body?.error === 'string' && Object.keys(body).length === 1;
  };
  const privateDenial = {verify:denied, hint:'Expected an uncached JSON 401 containing only an error.'};
  const syntheticId='11111111-2222-4333-8444-555555555555';
  const invitation = portable ? '/?invitation='+syntheticId : '/workspaces#invite=setup-check';
  const attachment = {recordId:syntheticId,fileId:syntheticId};
  const setupResponse = response => noStore(response) && !response.headers.has('set-cookie') && !response.headers.has('location');
  const setupBlocked = async response => response.status===503 && setupResponse(response) &&
    (await response.text())==='Harbor sign-in needs configuration. Contact the workspace administrator.';
  const fingerprintHint=(response,endpoint)=>{
    const actual=response.headers.get('x-harbor-build-fingerprint');
    if(!actual)return endpoint+' did not report a build fingerprint. Check the deployed release and routing.';
    if(!/^[a-f0-9]{64}$/.test(actual))return endpoint+' reported an invalid build fingerprint. Check the deployed release and proxy.';
    if(actual!==expectedBuild)return endpoint+' reported a different build than the expected build. Check deployed versions and traffic routing.';
  };
  const readinessCheck=portable||checkReadiness||checkReleaseReadiness;
  const expectedReadiness=beforeGoogle?'unavailable':'ready';
  const readiness={
    name:(portable?'Portable':'Native')+(beforeGoogle?' readiness waits for Google setup':' web app is ready'),
    path:'/healthz',
    verify:async response=>response.status===(beforeGoogle?503:200)&&
      (beforeGoogle||checkReleaseReadiness?setupResponse(response):noStore(response))&&
      (!checkReleaseReadiness||(response.headers.get('x-harbor-build-fingerprint')===expectedBuild&&
        response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()==='text/plain'))&&
      (await response.text())===expectedReadiness,
    hint:response=>{
      if(!response)return 'Readiness could not be reached. Check the origin and service.';
      if(response.status===404)return 'This origin does not serve Harbor readiness. Check the deployed release and routing.';
      const mismatch=checkReleaseReadiness&&fingerprintHint(response,'Readiness');
      if(mismatch)return mismatch;
      if(!noStore(response))return 'Readiness must return Cache-Control: no-store. Check proxy caching.';
      return 'Check the installed migration ledger, identity configuration and private file binding.';
    },
  };
  const checks = beforeGoogle ? [
    {name:'Google setup page is pending',path:'/auth/sign-in',verify:async response=>{
      if(response.status!==503||!setupResponse(response))return false;
      const html=await response.text();
      return html.includes('Google sign-in needs configuration.')&&html.includes('href="/privacy"')&&html.includes('href="/terms"')&&
        !html.includes('Continue with Google')&&!html.includes('href="/auth/google/start');
    },hint:'Check that the new deployment is serving the setup page before installing Google sign-in secrets.'},
    ...(portable?[{name:'Google setup callback matches the public origin',path:'/auth/sign-in',
      verify:async response=>{
        if(response.status!==503||!setupResponse(response))return false;
        const html=await response.text();
        if(html.length>262_144)return false;
        const document=parseDocument(html);
        const setup=DomUtils.findOne(node=>node.name==='details'&&node.attribs.class?.split(/\s+/).includes('welcome-setup'),document.children);
        if(!setup)return false;
        const callbacks=DomUtils.findAll(node=>node.name==='code',setup.children)
          .map(node=>DomUtils.textContent(node).trim()).filter(value=>value.endsWith('/auth/google/callback'));
        return callbacks.length===1&&callbacks[0]===origin+'/auth/google/callback';
      },
      hint:'Set HARBOR_LOGIN_ORIGIN to the exact public HTTPS origin before copying the callback into Google Cloud.',
    }]:[]),
    {name:'Setup JavaScript and stylesheets load',path:'/auth/sign-in',verify:response=>browserAssets(response,503)},
    {name:'Public trial privacy notice',path:'/privacy',verify:response=>setupResponse(response)&&notice('Your data in Harbor')(response),hint:noticeHint},
    {name:'Public trial terms',path:'/terms',verify:response=>setupResponse(response)&&notice('Trial terms')(response),hint:noticeHint},
    portable?{name:'Home directs visitors to the setup page',path:'/',verify:response=>
      response.status===307&&response.headers.get('location')==='/auth/sign-in'&&
      noStore(response)&&!response.headers.has('set-cookie')}:
      {name:'Home is unavailable before setup',path:'/',verify:setupBlocked},
    {name:'Google start is unavailable before setup',path:'/auth/google/start',verify:setupBlocked},
    {name:'Google callback is unavailable before setup',path:'/auth/google/callback',verify:setupBlocked},
    {name:'CRM is unavailable before setup',path:'/api/crm?mode=metadata',verify:setupBlocked,
      headers:{'oai-authenticated-user-id':'harbor-install-check','oai-authenticated-user-email':'harbor-install-check@example.test'}},
    {name:'Lead forms are unavailable before setup',path:'/forms/'+syntheticId,verify:setupBlocked},
    {name:'Unsubscribe is unavailable before setup',path:'/email/unsubscribe',verify:setupBlocked},
    ...(!portable?[
      {name:'Help centers are unavailable before setup',path:'/help/'+syntheticId,verify:setupBlocked},
      {name:'Help articles are unavailable before setup',path:'/help/'+syntheticId+'/setup-probe',verify:setupBlocked},
    ]:[]),
    ...(readinessCheck?[readiness]:[]),
  ] : [
    {name:'Home requires sign-in',path:'/',verify:redirectsToSignIn},
    {name:'Google sign-in page',path:'/auth/sign-in',verify:page('Continue with Google')},
    {name:'Sign-in JavaScript and stylesheets load',path:'/auth/sign-in',verify:browserAssets,hint:'Check that the Worker and its browser assets came from the same verified standalone build.'},
    {name:'Sign-in preserves a workspace invitation',path:'/auth/sign-in?return_to='+encodeURIComponent(invitation),verify:signInDestination(invitation)},
    {name:'Sign-in handles repeated return destinations',path:'/auth/sign-in?return_to=%2Fcontacts&return_to=%2Fcompanies',verify:signInDestination('/'),hint:'Check that the installed build includes the safe return-destination fix.'},
    {name:'Google redirect and sign-in cookie are safe',path:'/auth/google/start',
      verify:response=>identityOnly(response)&&googleClientMatches(response),
      hint:response=>response&&identityOnly(response)&&!googleClientMatches(response)?
        'Sign-in redirects to a different Google OAuth client. Check the configured sign-in client ID for this origin.':
        'Check the identity scopes, exact callback and short-lived secure attempt cookie.'},
    {name:'Public trial privacy notice',path:'/privacy',verify:notice('Your data in Harbor'),hint:noticeHint},
    {name:'Public trial terms',path:'/terms',verify:notice('Trial terms'),hint:noticeHint},
    {name:'CRM rejects forged Sites headers',path:'/api/crm?mode=metadata',...privateDenial,headers:{'oai-authenticated-user-id':'harbor-install-check','oai-authenticated-user-email':'harbor-install-check@example.test'}},
    ...(readinessCheck?[readiness]:[]),
    ...(portable ? [
      {name:'Record attachments require sign-in',path:'/api/record-attachments?'+new URLSearchParams(attachment),...privateDenial},
    ] : [
      {name:'Files require sign-in',path:'/api/files?fileId='+syntheticId,...privateDenial},
      {name:'Record attachments require sign-in',path:'/api/activity-attachments?'+new URLSearchParams({
        ...attachment,id:syntheticId,
      }),...privateDenial},
    ]),
    {name:'Workflows require sign-in',path:'/api/workflows',...privateDenial},
    {name:'Workspace settings require sign-in',path:'/api/workspaces?action=team',...privateDenial},
    {name:'Background processing requires sign-in',path:'/api/background-jobs',...privateDenial},
    {name:'API token settings require sign-in',path:'/api/api-tokens',...privateDenial},
    {name:'Records API rejects a synthetic bearer token',path:'/api/v1/records/contacts?limit=1',...privateDenial,
      headers:{authorization:'Bearer harbor_'+randomBytes(32).toString('hex')}},
  ];
  if (checkWriteDenials) {
    const verify = response => !response.headers.has('set-cookie') && !response.headers.has('location') && denied(response);
    const mutations = [
      ['CRM save','POST','/api/crm'],
      ['Workspace rename','POST','/api/workspaces'],
      ['API token creation','POST','/api/api-tokens'],
      ['Form settings','POST','/api/lead-forms'],
      ...(portable?[
        ['Job queue write','POST','/api/background-jobs'],
        ['Private attachment write','POST','/api/record-attachments'],
        ['Workflow write','POST','/api/workflows'],
      ]:[
        ['Background processor settings','PUT','/api/background-jobs'],
        ['Background processor start','POST','/api/background-jobs'],
        ['Bearer contact edit','PATCH','/api/v1/records/contacts/'+syntheticId],
        ['Private file archive','PATCH','/api/files/archive'],
      ]),
      ['CRM save with forged Sites headers','POST','/api/crm',{
        'oai-authenticated-user-id':'harbor-install-check','oai-authenticated-user-email':'harbor-install-check@example.test',
      }],
    ];
    for (const [label,method,path,extraHeaders] of mutations) checks.push({
      name:label+' requires authorization', path, method, verify, body:'{}',
      headers:{origin,'content-type':'application/json',...extraHeaders},
      hint:'Expected an uncached JSON 401 without cookies or a redirect.',
    });
  }
  if (checkOAuthGuards) {
    const verify = response => response.status===405&&noStore(response)&&response.headers.get('allow')==='GET'&&
      !response.headers.has('location')&&!response.headers.has('set-cookie');
    for (const endpoint of ['start','callback']) checks.push({
      name:`Google ${endpoint} rejects HEAD without starting sign-in`,path:'/auth/google/'+endpoint,method:'HEAD',verify,
      hint:'Expected an uncached 405 with Allow: GET and no redirect or cookies.',
    });
  }
  if(checkInstall){
    const publicAsset=response=>response.status===200&&!response.headers.has('location')&&!response.headers.has('set-cookie');
    const mediaType=response=>response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    checks.push({
      name:'Sign-in advertises Harbor install assets',path:'/auth/sign-in',
      verify:async response=>{
        if(response.status!==(beforeGoogle?503:200)||!setupResponse(response))return false;
        const doc=parseDocument(await response.text());
        const links=DomUtils.findAll(node=>node.name==='link',doc.children);
        return links.some(node=>node.attribs.rel==='manifest'&&node.attribs.href==='/harbor.webmanifest')&&
          links.some(node=>node.attribs.rel==='apple-touch-icon'&&node.attribs.href==='/harbor-icon-180.png');
      },
      hint:'Check the manifest and Apple touch icon links on the signed-out page.',
    },{
      name:'Install manifest opens the private Harbor entry point',path:'/harbor.webmanifest',
      verify:async response=>{
        if(!publicAsset(response)||mediaType(response)!=='application/manifest+json')return false;
        const manifest=await response.json();
        return manifest?.id==='/'&&manifest.scope==='/'&&manifest.start_url==='/'&&manifest.display==='standalone'&&
          Array.isArray(manifest.icons)&&[192,512].every(size=>manifest.icons.some(icon=>
            icon?.src===`/harbor-icon-${size}.png`&&icon.sizes===`${size}x${size}`&&icon.type==='image/png'));
      },
      hint:'Check that the manifest is served as application/manifest+json with the Harbor start URL and icons.',
    });
    for(const size of [180,192,512])checks.push({
      name:`Install icon is served at ${size}×${size}`,path:`/harbor-icon-${size}.png`,
      verify:async response=>{
        if(!publicAsset(response)||mediaType(response)!=='image/png'||!response.body)return false;
        const reader=response.body.getReader(),header=Buffer.alloc(24);
        try{
          for(let offset=0;offset<header.length;){
            const {done,value}=await reader.read();
            if(done)return false;
            const fragment=value.subarray(0,header.length-offset);
            header.set(fragment,offset);
            offset+=fragment.length;
          }
          return header.subarray(0,8).toString('hex')==='89504e470d0a1a0a'&&
            header.toString('ascii',12,16)==='IHDR'&&header.readUInt32BE(8)===13&&
            header.readUInt32BE(16)===size&&header.readUInt32BE(20)===size;
        }finally{await reader.cancel();}
      },
      hint:'Check that the published icon uses the expected PNG dimensions and media type.',
    });
  }
  if(checkUnsubscribe){
    const publicResponse=response=>!response.headers.has('location')&&!response.headers.has('set-cookie');
    checks.push({name:'Unsubscribe page requires explicit confirmation',path:'/email/unsubscribe',method:'GET',
      verify:async response=>{
        if(response.status!==200||!publicResponse(response))return false;
        const document=parseDocument(await response.text());
        const form=DomUtils.findOne(node=>node.name==='form',document.children);
        const confirmation=form&&DomUtils.findOne(node=>node.name==='button'&&
          DomUtils.textContent(node).trim()==='Unsubscribe from email',form.children);
        const referrer=response.headers.get('referrer-policy')??DomUtils.findOne(node=>node.name==='meta'&&
          node.attribs.name==='referrer',document.children)?.attribs.content;
        return !!confirmation&&referrer==='no-referrer';
      },hint:'Expected a public confirmation form with no cookies, redirect or referrer.'});
    for(const method of ['GET','HEAD'])checks.push({name:`Unsubscribe API rejects ${method}`,path:'/api/email/unsubscribe',method,
      verify:response=>response.status===(portable?404:405)&&publicResponse(response),
      hint:'Opening or previewing an unsubscribe link must leave confirmation to the visitor.'});
  }
  if(checkPublicDenials){
    const absentId=randomUUID();
    const cases=[
      {name:'Absent form returns no public page',path:'/forms/'+absentId},
      {name:'Absent form rejects a well-formed submission',path:'/api/public/forms/'+absentId,
        data:{id:randomUUID(),revision:1,payload:{name:'Harbor fictional check',email:'pilot-check@example.test'}}},
      {name:'Absent availability page returns no booking times',path:'/availability/'+absentId},
      {name:'Invalid booking receipt returns no status',path:'/api/public/booking-status',data:{receipt:'invalid'}},
      {name:'Invalid unsubscribe token returns no subscription data',path:'/api/email/unsubscribe',
        data:{token:'harbor-'+randomUUID()}},
    ];
    for(const {name,path,data} of cases)checks.push({
      name,path,method:data?'POST':'GET',body:data?JSON.stringify(data):undefined,
      headers:data?{origin,'content-type':'application/json'}:undefined,
      verify:response=>response.status===404&&noStore(response)&&!response.headers.has('location')&&!response.headers.has('set-cookie'),
      hint:'Expected an uncached 404 without cookies or a redirect.',
    });
  }
  if(publicFormId)checks.push({
    name:'Enabled public form renders with the expected framing policy',path:'/forms/'+publicFormId,
    verify:async response=>{
      if(response.status!==200||!noStore(response)||response.headers.has('location')||response.headers.has('set-cookie')||
        !response.headers.get('content-type')?.startsWith('text/html'))return false;
      const directives=(response.headers.get('content-security-policy')||'').split(/[,;]/)
        .map(value=>value.trim().split(/\s+/)).filter(([name])=>name.toLowerCase()==='frame-ancestors');
      if(directives.length!==1||directives[0].length!==2||
        directives[0][1]!== (expectedEmbedOrigin??"'none'"))return false;
      const html=await response.text();
      if(html.length>262_144)return false;
      const document=parseDocument(html);
      const form=DomUtils.findOne(node=>node.name==='form',document.children);
      if(form?.attribs.method!=='post')return false;
      const fields=DomUtils.findOne(node=>node.name==='fieldset'&&Object.hasOwn(node.attribs,'disabled'),form.children);
      return !!fields&&!!DomUtils.findOne(node=>node.name==='input'&&node.attribs.name==='email'&&
        node.attribs.type==='email',fields.children)&&!!DomUtils.findOne(node=>node.name==='button'&&
        node.attribs.type==='submit'&&Object.hasOwn(node.attribs,'disabled'),form.children);
    },
    hint:'Check that the fictional form is enabled and uncached, permits the intended website origin, and keeps submissions disabled until ready.',
  });
  if (expectedBuild) checks.push({
    name:'Sign-in matches the expected build fingerprint',path:'/auth/sign-in',
    verify:response=>response.status===(beforeGoogle?503:200)&&noStore(response)&&response.headers.get('x-harbor-build-fingerprint')===expectedBuild,
    hint:response=>{
      if(!response)return 'Sign-in could not be reached. Check the origin and service.';
      if(response.status!==(beforeGoogle?503:200))return 'Sign-in returned an unexpected status. Check the deployment and its identity setup.';
      return fingerprintHint(response,'Sign-in')||'Sign-in must return Cache-Control: no-store. Check proxy caching.';
    },
  });
  return Promise.all(checks.map(async ({name,path,verify,headers,method,body,hint}) => {
    let status = null,response;
    const diagnostic=()=>typeof hint==='function'?hint(response):hint;
    try {
      // Do not follow OAuth redirects or retain the attempt cookie.
      response = await request(path,headers,method,body);
      status = response.status;
      try {
        const ok = await verify(response);
        const detail=!ok&&diagnostic();
        return {name,status,ok,...(detail?{hint:detail}:{})};
      } finally {
        if (!response.bodyUsed) await response.body?.cancel();
      }
    } catch (error) {
      const detail=['TimeoutError','AbortError'].includes(error?.name)
        ? 'An HTTPS request exceeded the eight-second deadline. Check the service and its browser assets.'
        : diagnostic();
      return {name,status,ok:false,...(detail?{hint:detail}:{})};
    }
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{
    json:{type:'boolean'},portable:{type:'boolean'},'before-google':{type:'boolean'},'check-oauth-guards':{type:'boolean'},'check-write-denials':{type:'boolean'},'check-unsubscribe':{type:'boolean'},'check-public-denials':{type:'boolean'},'check-install':{type:'boolean'},'public-form':{type:'string'},'expect-embed-origin':{type:'string'},'check-readiness':{type:'boolean'},'check-release-readiness':{type:'boolean'},'expect-build':{type:'string'},'expect-contact':{type:'string'},'expect-google-client-id':{type:'string'},
  }});
  if(positionals.length!==1)throw Error('Usage: node scripts/check-standalone.mjs https://YOUR-HARBOR-ORIGIN [--json] [--portable] [--expect-build FINGERPRINT] [--expect-contact JSON|false] [--expect-google-client-id ID] [--before-google | --check-oauth-guards] [--check-write-denials] [--check-unsubscribe] [--check-public-denials] [--check-install] [--public-form UUID [--expect-embed-origin HTTPS_ORIGIN]] [--check-readiness | --check-release-readiness]');
  const contactArgument=values['expect-contact'];
  const expectedContact=contactArgument===undefined?undefined:contactArgument.trim()==='false'?false:readPublicPilotContact(contactArgument);
  const checks=await checkStandalone(positionals[0],fetch,values['expect-build'],{
    portable:values.portable,publicFormId:values['public-form'],expectedEmbedOrigin:values['expect-embed-origin'],expectedContact,expectedGoogleClientId:values['expect-google-client-id'],
    checkOAuthGuards:values['check-oauth-guards'],checkWriteDenials:values['check-write-denials'],checkUnsubscribe:values['check-unsubscribe'],checkPublicDenials:values['check-public-denials'],checkInstall:values['check-install'],beforeGoogle:values['before-google'],checkReadiness:values['check-readiness'],checkReleaseReadiness:values['check-release-readiness'],
  });
  const ok = checks.every(check => check.ok);
  if (values.json) {
    console.log(JSON.stringify({
      event:'harbor_hosted_acceptance',checkedAt:new Date().toISOString(),origin:new URL(positionals[0]).origin,
      runtime:values.portable?'portable':'native',beforeGoogle:values['before-google']===true,
      expectedBuild:values['expect-build']??null,ok,checks,
    }));
  } else {
    for (const {name,status,ok,hint} of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${status ?? 'invalid or unavailable response'})${hint?' · '+hint:''}`);
  }
  if (!ok) process.exitCode = 1;
}
