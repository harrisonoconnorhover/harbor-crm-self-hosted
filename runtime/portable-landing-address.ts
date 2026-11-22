import {landingDomains} from './portable-config.mjs';

export function workspaceLandingDomains(workspaceId:string|undefined):string[]{
  return Array.from(landingDomains(process.env)).filter(([,workspace])=>workspace===workspaceId).map(([origin])=>origin);
}

export function publicLandingAddress(page:{workspaceId:string;publishedSlug:string|null}){
  if(!page.publishedSlug)return null;
  const domain=workspaceLandingDomains(page.workspaceId)[0];
  return domain?domain+(page.publishedSlug==='home'?'/':'/'+page.publishedSlug):
    process.env.HARBOR_LOGIN_ORIGIN+'/p/'+page.workspaceId+'/'+page.publishedSlug;
}
