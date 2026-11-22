import {and,eq} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {z} from 'zod';
import {ApiError} from '../../lib/api-error';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

export function configuredMarketingWorkspace(env:NodeJS.ProcessEnv=process.env){
  return z.uuid().safeParse(env.HARBOR_MARKETING_WORKSPACE_ID).data?.toLowerCase();
}

export async function marketingWorkspaceForOwner(db:PostgresJsDatabase,actorId:string){
  const workspaceId=configuredMarketingWorkspace();
  if(!workspaceId)throw new ApiError(404,'Marketing is not configured on this installation.');
  const [row]=await db.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .where(and(eq(privateWorkspaces.id,workspaceId),eq(privateWorkspaces.ownerId,actorId)));
  if(!row)throw new ApiError(403,'Marketing is available to the owner of the configured workspace.');
  return row.id;
}

export async function marketingNavigationEnabled(db:PostgresJsDatabase,workspaceId:string,email:string){
  const [row]=await db.select({id:privateWorkspaces.id}).from(privateWorkspaces)
    .innerJoin(loginIdentities,eq(loginIdentities.id,privateWorkspaces.ownerId))
    .where(and(eq(privateWorkspaces.id,workspaceId),eq(loginIdentities.email,email.toLowerCase()))).limit(1);
  return Boolean(row);
}
