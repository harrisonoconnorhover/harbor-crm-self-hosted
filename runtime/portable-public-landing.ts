import {and,eq} from 'drizzle-orm';
import {publishedLanding} from '../db/postgres/landing-page-store';
import {trackingSites} from '../db/postgres/web-attribution-schema';
import {landingDocument} from '../lib/landing-document';
import {publicLandingAddress} from './portable-landing-address';
import {portableDb} from './portable-db';

export async function publicLanding(method:string,workspace:string,slug:string,canonical:string,servedOrigin=canonical,path='/p/'+workspace+'/'+slug,privacyControl=false,search=''){
  const db=portableDb(),page=await publishedLanding(db,workspace,slug,servedOrigin);
  if(page&&'redirect' in page){
    const destination=servedOrigin===canonical?'/p/'+workspace+'/'+page.redirect:page.redirect==='home'?'/':'/'+page.redirect;
    return new Response(null,{status:302,headers:{location:destination+search,'cache-control':'no-store','referrer-policy':'no-referrer'}});
  }
  const content=page?.draft;
  const pageLinks=new Map(page?.linkedPages.map(target=>[target.id,servedOrigin===canonical
    ?'/p/'+workspace+'/'+target.slug:target.slug==='home'?'/':'/'+target.slug]));
  const [site]=content&&!privacyControl?await db.select({id:trackingSites.id}).from(trackingSites).where(and(
    eq(trackingSites.workspaceId,workspace),eq(trackingSites.origin,servedOrigin),eq(trackingSites.enabled,true)
  )).limit(1):[];
  const policy="default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"+
    (content?.blocks.some(b=>b.type==='image')?'; img-src data:':'')+
    (content?.blocks.some(b=>b.type==='form'&&b.display==='inline')?'; frame-src '+canonical+'/forms/':'');
  const headers={...(content?.excludeFromSearch?{'x-robots-tag':'noindex'}:{}),'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer',
    'x-content-type-options':'nosniff','content-security-policy':site?
      policy+'; script-src '+canonical+'/journey.js; connect-src '+canonical+'/api/public/journey':policy};
  const journey=site?{siteId:site.id,path}:undefined;
  return new Response(method==='HEAD'?null:content?landingDocument(content,canonical,false,journey,publicLandingAddress({workspaceId:workspace,publishedSlug:slug}),pageLinks):'Page unavailable.',{status:content?200:404,headers});
}
