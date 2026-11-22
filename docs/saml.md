# Sign in to Harbor with company SSO

Portable Harbor supports [OpenID Connect](#sign-in-with-openid-connect) and [SAML 2.0](#register-harbor-at-the-identity-provider) for company sign-in. Start with an operator and an employee in a test application. The operator gets a private workspace. The employee signs in to accept an invitation to that workspace.

## Sign in with OpenID Connect

A self-hosted team can connect one company OpenID Connect issuer to portable Harbor. Apply portable migrations through `0245_oidc_directory_provisioning` before starting this version. Register Harbor as a confidential web client using the authorization code flow, S256 PKCE and RS256 ID tokens. Register one exact redirect URI, `https://crm.example.test/auth/oidc/callback`, using your Harbor hostname. The issuer must publish discovery metadata and public signing keys. Harbor supports client-secret basic or client-secret POST authentication. [OpenID Connect Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfigurationRequest) · [ID token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)

For web database roles with column-specific privileges, include SELECT and INSERT on `login_identities.oidc_subject` and `login_identities.oidc_directory_issuer`. Set these values in the private environment of every **web** replica:

| Setting | Value |
| --- | --- |
| `HARBOR_LOGIN_ORIGIN` | Public HTTPS origin people use for Harbor |
| `HARBOR_LOGIN_OIDC_ISSUER` | Exact issuer from the provider, including any tenant or realm path |
| `HARBOR_LOGIN_OIDC_CLIENT_ID` and `HARBOR_LOGIN_OIDC_CLIENT_SECRET` | Client ID and generated secret for this Harbor application |
| `HARBOR_LOGIN_OIDC_BINDINGS` | JSON mapping the case-sensitive subject (`sub`) issued to this client to the person's Harbor address, e.g. `{"001operator":"owner@example.test","002employee":"rep@example.test"}` |
| `HARBOR_LOGIN_ALLOWED_EMAILS` | Workspace owners, e.g. `owner@example.test` |
| `HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED` | `true` for invited employees |

Use the stable subject assigned by the provider for this particular client. Harbor identifies a person by issuer and subject. A change to their provider profile email does not reassign their Harbor account. An address already used by a different sign-in cannot be transferred this way. Direct OIDC supports up to 100 explicit bindings. To manage employees through your directory instead of maintaining one binding per employee, follow the provisioning steps below.

1. Run `node scripts/portable-web.mjs doctor web` with the deployment environment. Check `checks.oidcSignIn` and `oidcCallbackUrl`. This checks configuration. Complete the next steps to verify the provider connection.
2. Open Harbor, choose **Continue with company OpenID Connect**, and sign in as the test owner. Create a fictional contact. In **Users & Teams**, invite the bound employee's address.
3. In a separate browser profile, sign in as the employee, accept the invitation and open the contact. Revoke the employee's workspace access and refresh their existing contact link. The employee should lose access while the owner can still open it.
4. For a departing owner, remove their owner address and OIDC binding, then roll the updated environment to every web replica. A session is checked against the running replica's settings on its next authenticated request. Plan an independent owner before removing the last one.

The local `--saml` acceptance run also exercises an OIDC issuer, signed tokens and workspace revocation. To include the independent browser interoperability check, set `HARBOR_TEST_OIDC_PROVIDER` to the absolute path of `oidc-provider@9.15.1/lib/index.js` in a disposable test installation. The fixture uses loopback and fictional identities. Provider-specific MFA, tenant policies and hosted callbacks still require a rehearsal with the team's actual identity provider.

### Provision OpenID Connect employees

1. Set `HARBOR_OIDC_DIRECTORY_AUTHORITY_WORKSPACE_ID` to the UUID of the workspace whose directory may admit employees. Set `HARBOR_OIDC_DIRECTORY_EMAIL_DOMAIN` to the exact employee email domain. Enable invited sign-in and restart every web replica. Keep an explicit owner binding when this issuer is your only sign-in method. If another configured sign-in method already serves the owner, the OIDC bindings can be `{}`.
2. Run `node scripts/portable-web.mjs doctor web --check-workspace-access`. Check that `oidcDirectoryAuthority` and the database check both pass. A web role with column-specific grants needs SELECT and INSERT on `portable_directory_users.oidc_issuer` and `portable_directory_groups.oidc_issuer`, in addition to the standard directory permissions. Named directories share the existing external-ID and group-name storage columns.
3. As the workspace owner, open **Settings → API access** and create a **Manage OpenID Connect employees** token. Configure your directory's SCIM client with this token and `https://<your-harbor-host>/scim/v2`. Map its User `externalId` to the exact case-sensitive `sub` that the identity provider issues to Harbor's OIDC client. Verify that your provider exposes this value to its provisioning client. Map `userName` to the employee's Harbor email and `roles` to `viewer` or `editor`.
4. In **Users & Teams → Teams**, link an **OpenID Connect group** to the intended team. Supply the directory group name and its exact external ID. Push the User and Group, then sign in as the employee. A new editor starts with access to their own records. An owner can expand that access in Users & Teams.
5. Demote the fictional editor to viewer while they have a record open and confirm editing is denied. Deactivate them in the directory, refresh the record link, and check they have lost this workspace. An independently granted membership in a different workspace follows its own lifecycle.

The OIDC and SAML provisioning tokens each see their own employees and groups, including when both protocols use the same issuer name. Existing sign-in accounts keep their established provider identity.

## Register Harbor at the identity provider

Replace `crm.example.test` with the public HTTPS hostname people use to open Harbor. Use the same hostname on every replica.

| Identity provider setting | Value |
| --- | --- |
| SP entity ID or audience | `https://crm.example.test/auth/saml/metadata` |
| Assertion consumer service (ACS), reply URL | `https://crm.example.test/auth/saml/callback`, HTTP POST |
| Start URL | `https://crm.example.test/auth/saml/start` |
| Subject identifier (NameID) | Use a stable, non-reassigned employee identifier and the `urn:oasis:names:tc:SAML:2.0:nameid-format:persistent` format. |
| Signing | Sign **both** the SAML response and its assertion with the identity provider's configured certificate. RSA-SHA256 works with the local rehearsal. |
| Login flow | Users start at Harbor. The identity provider returns the request ID, intended recipient, audience and validity times in the signed response and assertion. |

Assign the two fictional users to the identity provider application. Obtain its entity ID, sign-in URL and public signing certificate. Once Harbor is configured, its entity ID URL serves SP metadata for import.

### Provider settings to check

- **Okta**. In the SAML integration wizard, use the ACS for the single sign-on, recipient and destination URLs. Use Harbor’s entity ID for the audience. Under advanced settings, select signing for both **Response** and **Assertion Signature**. Harbor initiates the request from its sign-in screen and uses an unencrypted assertion over HTTPS. [Okta SAML field reference](https://help.okta.com/en-us/Content/Topics/Apps/aiw-saml-reference.htm)
- **Microsoft Entra ID**. In the enterprise application’s SAML settings, enter Harbor’s entity ID and reply URL. Select **Sign SAML response and assertion** and SHA-256. Use the persistent NameID issued for this application when configuring the employee binding. [Signing options](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/certificate-signing-options) · [Microsoft NameID formats](https://learn.microsoft.com/en-us/entra/identity-platform/single-sign-on-saml-protocol)
- **Google Workspace**. The custom SAML app has settings for the ACS, entity ID, Name ID value and Name ID format. Select the persistent format, an administrator-controlled stable employee ID and **Signed response**. Google documents signing the envelope with this option. Confirm in the trial that both required signatures are present. End-to-end compatibility with a live Google Workspace SAML app remains unverified. [Custom SAML apps](https://knowledge.workspace.google.com/admin/apps/set-up-your-own-custom-saml-app)
- **Keycloak**. Create a SAML client with Harbor’s entity ID as the Client ID. Enter the exact Harbor ACS as both the valid redirect URI and POST assertion consumer URL. Choose persistent Name ID format. Enable **Include AuthnStatement**, **Sign documents** and **Sign assertions**. In an imported realm, explicitly set `saml.authnstatement` to `true`. Harbor sends unsigned sign-in requests, so leave **Client signature required** off for this client. [Keycloak SAML client settings](https://www.keycloak.org/docs/latest/server_admin/index.html#_client-saml-configuration)

For Keycloak, use the public signing certificate from the realm’s `/protocol/saml/descriptor`. Bind the exact persistent identifier issued for this Harbor client. The local trial sets it with an administrator-controlled user attribute, `saml.persistent.name.id.for.<Harbor entity ID>`. When provisioning a seat through SCIM, map that same value to `externalId`.

Run the invitation and removal checks below against your organization's provider before admitting teammates.

## Configure the web service

Use your host's secret manager or the local, Git-ignored `.harbor/compose/web.env`. Keep the identity provider's private signing key with the provider. Configure each Harbor web replica with the same values.

| Web setting | Value |
| --- | --- |
| `HARBOR_LOGIN_ORIGIN` | Public HTTPS origin, for example `https://crm.example.test`. |
| `HARBOR_LOGIN_SAML_ISSUER` | Exact identity provider entity ID from its metadata. |
| `HARBOR_LOGIN_SAML_ENTRY_POINT` | HTTPS sign-in URL supplied by the identity provider. |
| `HARBOR_LOGIN_SAML_CERT` | The provider’s public PEM signing certificate, including its BEGIN and END lines. During renewal, supply the current and replacement certificates separated by a newline. A single line containing literal `\n` for line breaks is also supported. |
| `HARBOR_LOGIN_SAML_ATTEMPT_SECRET` | Generate once with `openssl rand -base64 32` and save privately. This protects the short-lived browser sign-in attempt. |
| `HARBOR_LOGIN_SAML_BINDINGS` | JSON mapping each explicitly bound NameID to one distinct Harbor email. Bind the initial SAML operator here. A delegated company directory can provision other employees below. |
| `HARBOR_LOGIN_ALLOWED_EMAILS` | Addresses approved for private workspaces. For the example, use `operator@example.test`. |
| `HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED` | Set to `true` for employee sign-in through a pending invitation or active workspace membership. |

These bindings assign each fictional employee to a separate Harbor account.

```json
{"employee-481":"operator@example.test","employee-672":"rep@example.test"}
```

Harbor supports one SAML provider and up to 100 explicit bindings per installation. The issuer and persistent identifier identify the person. Harbor uses the address from an explicit binding or from an authorized directory provisioning request. Give existing Google and Microsoft accounts distinct addresses when enabling additional providers. Matching an email across two providers cannot merge their accounts.

Apply the release's database migrations, recreate the web service and check its configuration as described in the [self-host guide](self-host.md#2-sign-in-and-invite-a-teammate). Provider settings are read at startup.

### Compare Harbor with the provider’s metadata

Export the metadata XML for the Harbor application from your identity provider’s admin console. Make that file available to the web process and run this command with the same environment as the web service:

```sh
node scripts/portable-web.mjs doctor web --saml-metadata /path/to/provider.xml
```

Check `checks.samlMetadata`. An `ok` result means the exported issuer and HTTP-Redirect sign-in address match Harbor and every advertised signing certificate is configured. During renewal, `provider_certificate_missing` means Harbor recognizes at least one published key and still needs another. Compare the `providerOnly` fingerprints with the provider’s console before changing configuration. `harborOnly` lists certificates Harbor still trusts that the export omits. These can be expected briefly during rotation. [Microsoft’s federation metadata reference](https://learn.microsoft.com/en-us/entra/identity-platform/federation-metadata)

Use a single application’s SAML 2.0 identity-provider descriptor with one public certificate per signing key. The check reads the local file and leaves sign-in settings untouched. After it passes, verify an employee sign-in against your actual provider.

### Renew the provider’s signing certificate

1. Obtain the replacement **public signing certificate** from the same identity provider. Add it below the current certificate in `HARBOR_LOGIN_SAML_CERT`, with each PEM block on its own lines. Keep the issuer, employee bindings and attempt secret in place.
2. Restart every Harbor web replica with both certificates. On each replica, run `node scripts/portable-web.mjs doctor web` and compare the two SHA-256 fingerprints under `samlSigningCertificates` with the provider’s public certificates. Confirm a fresh test employee sign-in works. Once every replica accepts both certificates, switch signing at the provider and repeat the sign-in. Verify that the employee opens the same workspace.
3. Allow ten minutes for sign-ins started before the switch to finish. Remove the old certificate, restart every replica with the replacement alone and verify a fresh sign-in. Existing Harbor sessions continue through a planned renewal. If the old signing key is compromised, remove its certificate immediately.

## Provision employees from the company directory

Workspace owners can open **Settings → Team directory → Check company directory access** and enter an employee's email, or select **Active editors**, **Active viewers** or **Inactive employees**. Choose **Check access**. Harbor lists up to 25 directory employees per page with their provider, current workspace role and team. The editor list identifies backup administrators. Deactivating an employee moves them to the inactive list. Deleting their directory entry removes them from these results. Manually invited teammates appear in the regular Team directory.

On the active editor and viewer lists, choose a **Primary team** to review that team's direct members. Nested teams appear by their full path. Select **Include child teams** to see the whole department, including the selected team. Each employee shows their actual primary team. Moving a team changes which department will list it on the next search. **No primary team** finds active employees who still need a team assignment. The selection applies to every page.

Choose **View record access history** beside an active or inactive employee to see their recorded activity in this workspace, including attachment downloads. This link follows the Harbor account across email changes and still works after deactivation. If the directory deletes the entry, a saved history link continues to work. The separate email filter matches the address recorded at the time of access.

Map the directory’s **displayName** to show employee names beside their access details. Apply portable migration `0225` first. The name belongs to that workspace’s directory entry. The sign-in email and stable employee ID stay the same when someone changes their name. A directory can send a name and an access change in one PATCH. Harbor saves both together. An omitted name keeps the last value, and removing `displayName` clears it. Existing seats without a supplied name display by email.

Provisioning clients can review their own roster through `GET /scim/v2/Users`. Use the `filter` parameter with `active eq false`, `active eq true`, `roles.value eq "viewer"` or `roles.value eq "editor"`. The result count and pages reflect the same filter. A token sees only employees from its provider in its workspace. For example, requesting `filter=active%20eq%20false&count=0` returns the number of deactivated employees without downloading their details.

To check who can edit in a directory-managed team, use `active eq true and roles.value eq "editor" and groups.value eq "<SCIM group ID>"`. Both `GET /scim/v2/Users` and `POST /scim/v2/Users/.search` accept exact employee filters joined by `and`. Use `count=0` to get just the matching headcount. The group ID comes from the provisioning API. To verify a particular employee’s direct membership after a directory transfer, search Groups with `id eq "<group ID>" and members.value eq "<user ID>"`. With `count=0`, the old team should return zero and the new team one. Users also accepts `id eq "<user ID>" and active eq true and groups.value eq "<group ID>"`. Use the IDs Harbor returned from SCIM. Both URL filters and the corresponding `/.search` endpoint support these checks. The owner screen uses the employee's current Harbor primary team, including manual assignments. [SCIM filter expressions](https://www.rfc-editor.org/rfc/rfc7644#section-3.4.2.2)

For an active employee, choose **Review record and field access**. The preview shows their effective role, primary team, which records they can view and edit, and which restricted fields are visible across Contacts, Companies and Deals. A Viewer has read-only access. Team scope without a primary team covers only the employee’s own records. If a directory role change replaces the membership or the employee is removed, the old preview link stops working. Look up the email again for the current result.

Use this when your identity provider or directory service can push SCIM 2.0 Users to a custom application. SAML signs the employee in. SCIM controls their seat and role in one Harbor workspace.

1. Sign in as the workspace owner. Keep the owner’s address in the operator allowlist. Enable invited sign-in on the web service.
2. Choose how the directory may identify new hires. For a fixed roster, set the NameID bindings above. For automatic onboarding, set **both** `HARBOR_SAML_DIRECTORY_AUTHORITY_WORKSPACE_ID` to the exact workspace ID and `HARBOR_SAML_DIRECTORY_EMAIL_DOMAIN` to the employer domain, for example `example.test`. Use an organization-controlled domain. This permits its directory to bind a new employee there when the NameID and address are unused. Apply the settings to every web replica and run the workspace access doctor.
3. In **Settings → Data management → API access**, give the token a name, choose **Manage company SSO employees**, then **Create directory token**. Save the token privately in the provisioning client. Use bearer authentication and the base URL `https://crm.example.test/scim/v2`, replacing the sample host. Each token is bound to the issuing workspace and configured SAML issuer. Changing the issuer requires a new token.
4. Map the directory’s stable employee ID to `externalId`. It must match the exact, case-sensitive NameID returned at sign-in. Map their Harbor email to `userName` and employment status to `active`. If role provisioning is enabled, send one core `roles` entry with a `value` of `viewer` or `editor`. Provision one fictional employee and confirm they appear in the Harbor team directory and can sign in without a manual invitation.
5. Deactivate that employee in the provisioning client. Refresh their existing record link and check the seat count from the owner account. Reactivation should preserve their directory resource ID and create a fresh workspace grant. Independently granted memberships in other workspaces have their own lifecycle.

Directory promotion from viewer to editor preserves the viewing scope and enables editing of owned records. Workspace administrators can then expand editing to team or workspace records. Repeated syncs with the same role preserve the administrator’s choice.

A directory can clear an employee’s mapped role with a PATCH removing `roles` or replacing it with `[]`. An active editor becomes a Viewer. The existing session keeps its viewing scope and loses editing immediately. Clearing roles on an inactive employee leaves the seat inactive.

The directory exposes Users and Groups. Reading or listing a User shows the current group pushed by that directory, including its display name and Group resource link. Manually assigned teams stay out of this list. Change managed membership on the Group resource. In **Workspaces → Teams and pods**, select a team, enter the directory’s group display name under **Company SSO group**, and choose **Link directory group**. Provision employees before pushing their group. Harbor matches the initial name without regard to case and returns a stable group ID. Use that ID for subsequent membership updates and renames. Each employee has one primary team. To move them, remove them from the old group before adding them to the new one. Existing manual assignments must be cleared by the owner first. Unlinking or deleting a group releases its managed team assignments. Employees keep their seats. Linking a replacement group requires a fresh owner mapping. Entra uses its separate directory token and group object IDs. Directory tokens and workspace access grants must be re-established on a disposable restore before it can serve teammates.

For employee and group filters and PATCH operations, a directory can use short attribute names or their full core schema names. For example, replacing `urn:ietf:params:scim:schemas:core:2.0:User:active` with `false` deactivates the same seat as replacing `active`. Group updates can likewise use `urn:ietf:params:scim:schemas:core:2.0:Group:members`. Case-sensitive external IDs keep their original spelling. [SCIM attribute notation](https://www.rfc-editor.org/rfc/rfc7644#section-3.10)

To check a pushed membership, filter `/scim/v2/Users` by `groups.value eq "<group ID>"` to page through that team’s employees. Filter `/scim/v2/Groups` by `members.value eq "<employee ID>"` to find the employee’s managed group. Use the IDs Harbor returned for those SCIM resources. Both lookups support `count=0` for a count alone. Manual assignments stay in Harbor’s Team directory.

To reconcile access for a team, request only the fields you need. For example, `GET /scim/v2/Users?attributes=userName,active,roles.value,groups.value` returns sign-in email addresses, access status, roles and directory group IDs. Use the existing `filter`, `startIndex` and `count` parameters to narrow or page the roster. To list group names without loading their members, use `GET /scim/v2/Groups?attributes=displayName`.

To keep an employee's email or an external group ID out of request URLs, send the lookup as a JSON body to `POST /scim/v2/Users/.search` or `POST /scim/v2/Groups/.search`. Use the same workspace directory token, filters and pagination as the GET list. The response uses the same resource IDs, field permissions and read limit. For example:

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:SearchRequest"],
  "filter": "userName eq \"rep@example.test\"",
  "attributes": ["userName", "active", "groups.value"],
  "count": 10
}
```

Supply `attributes` or `excludedAttributes` as an array of field names. Set `count` to zero to retrieve just the total. [SCIM POST search](https://www.rfc-editor.org/rfc/rfc7644#section-3.4.3)

The same field selection works when reading one employee or group and when creating or updating one. For example, `?attributes=active` on a deactivation returns the employee ID and updated status. Use `excludedAttributes` to leave fields out instead. Each resource includes its ID and schema. [SCIM response attributes](https://www.rfc-editor.org/rfc/rfc7644#section-3.9)

### Okta employee provisioning

For an Okta custom app, use the SCIM 2.0 base URL and workspace directory token from step 3. Use `userName` as the matching attribute, enable user creation, updates and deactivation, and enable Group Push only for groups already linked by the Harbor owner. Use separate groups for app assignment and Group Push. [Okta Group Push guide](https://help.okta.com/oie/en-us/content/topics/users-groups-profiles/usgp-about-group-push.htm) Map the same stable employee identifier to the SAML NameID and the initial SCIM `externalId`. Harbor handles the password placeholder in Okta’s create request by discarding it. The SAML provider handles sign-in. [Okta SCIM user operations](https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20)

When Okta pushes a group rename, Harbor accepts its group ID alongside the new name. The existing team mapping and membership carry forward. [Okta group update examples](https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20#update-a-specific-group-name)

After creation, Okta may identify the employee by Harbor’s resource ID and the original username on a full profile update. Harbor preserves the stored external ID. An explicit `active: false` removes the seat. Profile updates that omit `active` or `roles` preserve the current status or role. An explicit empty roles list on an active user restores Viewer access. Reactivating an employee without a role creates a fresh Viewer grant.

To qualify your installation, assign a test employee, update their profile, then unassign the app while they have a Harbor record open. Refresh that record to verify access ends. Reassign the app and check the role in Harbor’s team directory. Push a team change and reload a teammate-owned record in the employee’s existing session to check access. The built app passed this lifecycle locally with Okta-format requests. An actual Okta tenant remains to be tested.

## Verify your installation

1. Open the public Harbor URL in a fresh browser profile. Choose **Continue with company SSO** and sign in as the test operator. Create a fictional Contact.
2. In **Workspaces**, invite the employee's bound email as a Viewer. In another browser profile, open the invitation, choose company SSO, sign in as the employee and accept. Open the shared Contact.
3. Revoke the employee's workspace membership from the operator profile and reload the existing Contact link in the employee profile. Confirm access is denied. If this was their only invitation or membership and they're outside the owner allowlist, a fresh sign-in should also be denied.
4. Sign the operator out of Harbor and reload a private page. Harbor sign-out ends Harbor access for the selected session scope. A later visit to the company provider can still use that provider's own sign-in session.

The portable regression suite exercises a simulated identity provider using disposable certificates. It covers certificate renewal, sign-ins in progress during a switch, invitation acceptance, access revocation and coexistence with Google. The focused `node tests/portable-fixtures/run.mjs --saml` rehearsal also exercises the browser form POST. Run it in a built development checkout with PostgreSQL 18 tools, the fixture dependencies, Chromium and Playwright available. Set `HARBOR_TEST_CHROME` and `HARBOR_TEST_PLAYWRIGHT` to the browser executable and Playwright module path when they are installed separately. With Docker running, `node tests/portable-fixtures/run.mjs --keycloak` uses the same prerequisites to run a separate Keycloak 26.8.2 server on loopback. It reads the realm metadata, signs a fictional operator and employee into Harbor in separate browser sessions and checks access to a shared contact before and after removal. It then sends SCIM requests directly to Harbor to create a fresh Viewer seat and deactivate it. Both the existing session and a fresh Keycloak sign-in lose access. Automatic provisioning from a managed directory still needs a tenant trial. Use the four steps above to qualify your organization's real provider and proxy.
