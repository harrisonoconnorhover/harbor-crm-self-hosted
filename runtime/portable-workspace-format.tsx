'use client';

import {createContext,useContext,type ReactNode} from 'react';
import {workspaceDate,workspaceNumber,type AccountDefaults} from '../lib/portable-account-defaults';

const WorkspaceFormat=createContext<AccountDefaults|null>(null);
export function WorkspaceFormatProvider({value,children}:{value:AccountDefaults|null;children:ReactNode}){
  return <WorkspaceFormat.Provider value={value}>{children}</WorkspaceFormat.Provider>;
}
export function useWorkspaceDefaults(){return useContext(WorkspaceFormat);}
export function WorkspaceName({fallback}:{fallback:string}){
  return useWorkspaceDefaults()?.name??fallback;
}
export function WorkspaceDate({value,day=false,children}:{value:string|number;day?:boolean;children?:ReactNode}){
  const settings=useWorkspaceDefaults();
  return settings?workspaceDate(value,settings,!day):children??new Date(value).toLocaleString();
}
export function WorkspaceNumber({value,kind='number',children}:{value:number|string;kind?:Parameters<typeof workspaceNumber>[2];children?:ReactNode}){
  const settings=useWorkspaceDefaults();
  return settings?workspaceNumber(value,settings,kind):children??Number(value).toLocaleString();
}
