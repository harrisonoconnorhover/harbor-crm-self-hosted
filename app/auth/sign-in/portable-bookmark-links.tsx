'use client';

import {useSyncExternalStore} from 'react';
import {ProviderLinks,type SignInProviders} from './provider-links';

function subscribe(listener:()=>void){
  window.addEventListener('hashchange',listener);
  return ()=>window.removeEventListener('hashchange',listener);
}

// Only forward known section names for their original page. Unrelated fragments
// (such as a private invitation token) must stay out of provider sign-in URLs.
const viewAnchors=new Map<string,RegExp>([
  ['workspaces',/^#(?:invite-teammate|team-directory|workspace-role-guide(?:-(?:editor|viewer|owner|backup|records|team|extras))?)$/],
  ['email-settings',/^#(?:email-(?:templates|connection|suppressions|never-log|opt-out)|outlook-connection)$/],
  ['workflows',/^#recent-runs$/],
  ['dashboards',/^#report-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i],
  ['forms',/^#form-inquiries$/],
  ['getting-started',/^#guide-import$/],
]);
const recordAnchor=/^#portable-(?:record-properties|property-history|logged-activities|activity-access|sales-sequences|task-history|contact-jobs|contact-files|record-links)$/;
const noAnchor=()=>'';

function bookmarkAnchor(returnTo:string){
  const url=new URL(returnTo,window.location.origin);
  if(url.pathname!=='/'||url.hash)return '';
  const view=url.searchParams.get('view');
  const onRecord=url.searchParams.has('contact')||url.searchParams.has('record');
  const pattern=view?viewAnchors.get(view):onRecord?recordAnchor:undefined;
  return pattern?.test(window.location.hash)?window.location.hash:'';
}

export function PortableBookmarkLinks(props:SignInProviders){
  const anchor=useSyncExternalStore(subscribe,()=>bookmarkAnchor(props.returnTo),noAnchor);
  return <ProviderLinks {...props} returnTo={props.returnTo+anchor}/>;
}
