import {oidcDirectoryScope} from './portable-company-oidc-config';
import {portableOidcDirectoryConfig,portableDirectoryConfig,portableSamlDirectoryConfig,samlDirectoryScope} from './portable-login-config';
import {z} from 'zod';
import {createPortableApiToken,readPortableApiTokens,revokePortableApiToken} from '../db/postgres/portable-api-token-store';
import {lockPortableLoginSession} from '../db/postgres/identity-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {entraDirectoryScope,portableTokenCreate,portableTokenPage,portableTokenRevoke} from '../lib/portable-api-tokens';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';
import {requestSessionHash} from './portable-identity';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

async function tokens(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response){
      user.headers.set('cache-control','private, no-store');
      return user;
    }
    if(user.guest)return json({error:'Only the workspace owner can manage API tokens.'},403);
    const db=portableDb(),params=new URL(request.url).searchParams;
    if(request.method!=='POST'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid token query.'},400);
      return json(await readPortableApiTokens(db,user.userId,portableTokenPage.parse(Object.fromEntries(params))));
    }
    if(params.size)return json({error:'Invalid token query.'},400);
    const text=await readBoundedRequestText(request,4096);
    if(text===null)return json({error:'Token settings are too large.'},413);
    const body=JSON.parse(text);
    const change=body?.action==='revoke'?portableTokenRevoke.parse(body):portableTokenCreate.parse(body);
    const sessionHash=await requestSessionHash(request.headers);
    const sessionEnded=()=>json({error:'Sign in again to manage API tokens.'},403);
    if(!sessionHash)return sessionEnded();
    return await db.transaction(async tx=>{
      if(!await lockPortableLoginSession(tx,{...user,sessionHash}))return sessionEnded();
      if('action' in change){
        return await revokePortableApiToken(tx,user.userId,change.id)?json({ok:true}):json({error:'Token not found.'},404);
      }
      let directoryScope:string|undefined;
      if('purpose' in change&&change.purpose==='saml_directory'){
        const config=portableSamlDirectoryConfig();
        if(!config)return json({error:'Enable company SSO and invited access first.'},409);
        directoryScope=samlDirectoryScope(config.issuer);
      }else if('purpose' in change&&change.purpose==='oidc_directory'){
        const config=portableOidcDirectoryConfig();
        if(!config)return json({error:'Enable OpenID Connect sign-in and invited access first.'},409);
        directoryScope=oidcDirectoryScope(config.issuer);
      }else if('purpose' in change){
        const config=portableDirectoryConfig();
        if(!config)return json({error:'Enable organizational Microsoft sign-in and invited access first.'},409);
        directoryScope=entraDirectoryScope(config.tenant);
      }
      return json(await createPortableApiToken(tx,user.userId,change,directoryScope),201);
    });
  }catch(error){
    if(error instanceof z.ZodError)return json({error:error.issues[0]?.message??'Check the token settings.'},400);
    if(error instanceof SyntaxError)return json({error:'Send valid JSON.'},400);
    return json({error:'Could not manage API tokens.'},503);
  }
}

export {tokens as GET,tokens as POST};
