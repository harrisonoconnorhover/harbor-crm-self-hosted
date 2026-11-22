import {z} from 'zod';
import {effectiveMemberToolPolicy,memberTools} from '../lib/portable-tool-permissions';
import type {PortableTool} from '../lib/portable-nav-tools';
import {getChatGPTUser} from '../app/chatgpt-auth';
import {readAccountDefaults} from '../db/postgres/account-defaults-store';
import {WorkspaceFormatProvider} from './portable-workspace-format';
import {notFound} from 'next/navigation';
import {outlookConfig} from './portable-outlook-provider';
import {configuredMarketingWorkspace,marketingNavigationEnabled} from '../db/postgres/marketing-workspace-store';
import {canReadSharedForecast} from '../db/postgres/forecast-goal-store';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {portableDb} from './portable-db';
import type {ReactNode} from 'react';
import {PortableNavigationOptions} from './portable-crm-header';
import {portableCalendarConfig} from './portable-calendar-config';
import {portablePersonalGoogleConfig} from './portable-google-config';
import {objectStorageConfigured} from './portable-object-storage';

// Only availability travels to the browser. Each destination checks access itself.
export async function withPortableNavigation(email:string,body:ReactNode,scope?:{actorId:string;workspaceId?:string;forecastAvailable?:boolean}){
  const selected=configuredMarketingWorkspace();
  if(scope?.workspaceId!==undefined&&!z.string().guid().safeParse(scope.workspaceId).success)notFound();
  const [grant,forecastAvailable]=scope?.workspaceId?await Promise.all([
    sharedWorkspaceGrant(portableDb(),scope.actorId,scope.workspaceId,true),
    scope.forecastAvailable??canReadSharedForecast(portableDb(),scope.actorId,scope.workspaceId),
  ]):[undefined,true];
  const actorId=scope?.actorId??(await getChatGPTUser())?.userId;
  const settings=actorId?await readAccountDefaults(portableDb(),actorId,scope?.workspaceId):undefined;
  const hiddenTools:PortableTool[]=grant?memberTools.filter(tool=>effectiveMemberToolPolicy(grant,tool).view==='none'):[];
  if(hiddenTools.includes('tickets'))hiddenTools.push('help-desk');
  if(hiddenTools.includes('contacts'))hiddenTools.push('segments','files');
  const allRecords=grant?.viewScope==='all';
  return <WorkspaceFormatProvider value={settings?.revision?settings.defaults:null}><PortableNavigationOptions value={{hiddenTools,forecastAvailable,sharedRole:grant?.role,callsAvailable:Boolean(grant?.contactOutreach||grant?.recordActivities),allRecords,
    filesEnabled:objectStorageConfigured()&&(!scope?.workspaceId||!!grant?.contactFiles),marketingEnabled:Boolean(selected&&await marketingNavigationEnabled(portableDb(),selected,email)),
    calendarAvailable:portableCalendarConfig()?.owner===email.toLowerCase()||Boolean(portablePersonalGoogleConfig('calendar')||outlookConfig('outlook-calendar'))}}>{body}</PortableNavigationOptions></WorkspaceFormatProvider>;
}
