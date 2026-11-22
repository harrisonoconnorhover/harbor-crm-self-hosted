import {sql} from 'drizzle-orm';
import {check,foreignKey,index,pgTable,primaryKey,text,unique,uniqueIndex,uuid,varchar} from 'drizzle-orm/pg-core';
import {workspaceTeams} from './workspace-team-schema';
import {workspaceViewers} from './workspace-viewer-schema';
import {loginIdentities} from './identity-schema';
import {privateWorkspaces} from './workspace-schema';

// A directory resource survives deactivation. A current membership is its access grant.
// SAML and OIDC use the existing opaque external ID and group name columns. The issuer columns distinguish their namespaces.
export const directoryUsers=pgTable('portable_directory_users',{
  id:uuid('id').primaryKey(),
  workspaceId:uuid('workspace_id').notNull().references(()=>privateWorkspaces.id,{onDelete:'cascade'}),
  userId:text('user_id').notNull().references(()=>loginIdentities.id,{onDelete:'cascade'}),
  oidcIssuer:text('oidc_issuer'),
  samlIssuer:text('saml_issuer'),
  samlExternalId:text('saml_external_id'),
  displayName:varchar('display_name',{length:254}),
},table=>[
  unique('portable_directory_user_workspace').on(table.workspaceId,table.userId),
  check('portable_directory_saml_pair',sql`num_nonnulls(${table.samlIssuer},${table.oidcIssuer}) = CASE WHEN ${table.samlExternalId} IS NULL THEN 0 ELSE 1 END`),
  // Bound the index size for long issuer IDs and NameIDs. Authorization compares the full, original strings.
  uniqueIndex('portable_directory_saml_external').on(table.workspaceId,sql`md5(${table.samlIssuer})`,sql`md5(${table.samlExternalId})`)
    .where(sql`${table.samlIssuer} IS NOT NULL`),
  uniqueIndex('portable_directory_oidc_external').on(table.workspaceId,sql`md5(${table.oidcIssuer})`,sql`md5(${table.samlExternalId})`)
    .where(sql`${table.oidcIssuer} IS NOT NULL`),
]);

// The mapping is created by the owner. Only provisioned mappings have a public SCIM resource ID.
export const directoryGroups=pgTable('portable_directory_groups',{
  workspaceId:uuid('workspace_id').notNull(),
  teamId:uuid('team_id').notNull(),
  tenant:uuid('tenant'),
  externalId:uuid('external_id'),
  oidcIssuer:text('oidc_issuer'),
  samlIssuer:text('saml_issuer'),
  samlGroupName:text('saml_group_name'),
  samlExternalId:text('saml_external_id'),
  groupId:uuid('group_id'),
  displayName:text('display_name'),
},t=>[
  primaryKey({columns:[t.workspaceId,t.teamId]}),
  unique('portable_directory_group_object').on(t.workspaceId,t.tenant,t.externalId),
  check('portable_directory_group_provider',sql`(
    ${t.tenant} IS NOT NULL AND ${t.externalId} IS NOT NULL AND ${t.samlIssuer} IS NULL AND ${t.oidcIssuer} IS NULL AND ${t.samlGroupName} IS NULL AND ${t.samlExternalId} IS NULL
  ) OR (
    ${t.tenant} IS NULL AND ${t.externalId} IS NULL AND num_nonnulls(${t.samlIssuer},${t.oidcIssuer})=1 AND ${t.samlGroupName} IS NOT NULL
    AND length(trim(${t.samlGroupName})) BETWEEN 1 AND 120 AND (${t.samlExternalId} IS NULL OR length(${t.samlExternalId}) BETWEEN 1 AND 254)
  )`),
  uniqueIndex('portable_directory_saml_group_mapping').on(t.workspaceId,sql`md5(${t.samlIssuer})`,sql`lower(${t.samlGroupName})`).where(sql`${t.samlIssuer} IS NOT NULL`),
  uniqueIndex('portable_directory_saml_group_name').on(t.workspaceId,sql`md5(${t.samlIssuer})`,sql`lower(${t.displayName})`).where(sql`${t.samlIssuer} IS NOT NULL AND ${t.groupId} IS NOT NULL`),
  uniqueIndex('portable_directory_saml_group_external').on(t.workspaceId,sql`md5(${t.samlIssuer})`,t.samlExternalId).where(sql`${t.samlExternalId} IS NOT NULL`),
  uniqueIndex('portable_directory_oidc_group_mapping').on(t.workspaceId,sql`md5(${t.oidcIssuer})`,sql`lower(${t.samlGroupName})`).where(sql`${t.oidcIssuer} IS NOT NULL`),
  uniqueIndex('portable_directory_oidc_group_name').on(t.workspaceId,sql`md5(${t.oidcIssuer})`,sql`lower(${t.displayName})`).where(sql`${t.oidcIssuer} IS NOT NULL AND ${t.groupId} IS NOT NULL`),
  uniqueIndex('portable_directory_oidc_group_external').on(t.workspaceId,sql`md5(${t.oidcIssuer})`,t.samlExternalId).where(sql`${t.samlExternalId} IS NOT NULL`),
  unique('portable_directory_group_resource').on(t.workspaceId,t.groupId),
  uniqueIndex('portable_directory_group_name').on(t.workspaceId,t.tenant,sql`lower(${t.displayName})`).where(sql`${t.groupId} IS NOT NULL`),
  foreignKey({name:'portable_directory_group_team',columns:[t.workspaceId,t.teamId],foreignColumns:[workspaceTeams.workspaceId,workspaceTeams.id]}),
  check('portable_directory_group_provisioned',sql`(${t.groupId} IS NULL AND ${t.displayName} IS NULL) OR
    (${t.groupId} IS NOT NULL AND ${t.displayName} IS NOT NULL AND length(trim(${t.displayName})) BETWEEN 1 AND 120)`),
]);

// Keep the primary team on the ordinary membership. This row records who manages it.
// Deactivating the User removes the membership and the associated assignment together.
export const directoryGroupMembers=pgTable('portable_directory_group_members',{
  workspaceId:uuid('workspace_id').notNull(),
  userId:text('user_id').notNull(),
  groupId:uuid('group_id').notNull(),
},t=>[
  primaryKey({columns:[t.workspaceId,t.userId]}),
  foreignKey({name:'portable_directory_member_group',columns:[t.workspaceId,t.groupId],foreignColumns:[directoryGroups.workspaceId,directoryGroups.groupId]}),
  foreignKey({name:'portable_directory_member_access',columns:[t.workspaceId,t.userId],foreignColumns:[workspaceViewers.workspaceId,workspaceViewers.viewerId]}).onDelete('cascade'),
  foreignKey({name:'portable_directory_member_user',columns:[t.workspaceId,t.userId],foreignColumns:[directoryUsers.workspaceId,directoryUsers.userId]}).onDelete('cascade'),
  index('portable_directory_group_roster').on(t.workspaceId,t.groupId),
]);
