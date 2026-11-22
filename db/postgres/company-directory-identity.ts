import {and,eq} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {loginIdentities} from './identity-schema';

// Identity provenance survives removal of the provisioning workspace's membership.
// Sign-in still requires an independent current membership, invitation, or explicit allowlist.
export async function companyDirectoryIdentity(db:Pick<PostgresJsDatabase,'select'>,protocol:'saml'|'oidc',workspaceId:string,issuer:string,subject:string){
  const [row]=await db.select({email:loginIdentities.email}).from(loginIdentities)
    .where(and(eq(loginIdentities.directoryAuthority,workspaceId),eq(protocol==='saml'?loginIdentities.samlDirectoryIssuer:loginIdentities.oidcDirectoryIssuer,issuer),
      eq(protocol==='saml'?loginIdentities.samlSubject:loginIdentities.oidcSubject,subject))).limit(1);
  return row?.email;
}
