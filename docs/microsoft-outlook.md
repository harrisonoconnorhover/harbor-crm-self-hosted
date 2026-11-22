# Microsoft sign-in and Outlook for self-hosted Harbor

Portable Harbor supports Microsoft sign-in and two optional personal connections. A team can use Google sign-in and connect Outlook, use Microsoft sign-in on its own, or offer both sign-in buttons. Connections are available in a user's private workspace. A workspace administrator cannot connect a teammate's mailbox for them.

For an existing Harbor installation, take the matched database and file backup described in the [self-host guide](self-host.md). Build the new image, set `HARBOR_IMAGE` to its tag, and run `docker compose -f compose.portable.yaml run --rm web node scripts/portable-web.mjs migrate` before starting it. The migration adds Microsoft identities to the existing database. Google users continue to reach their records with their original sign-in.

## Sign in with Microsoft

1. In **Microsoft Entra ID → App registrations → New registration**, create a sign-in app for this Harbor installation. For one Microsoft 365 organization, choose **Accounts in this organizational directory only**. For personal Microsoft accounts, choose a registration that supports them and use Microsoft's consumer tenant ID `9188040d-6c67-4c5b-b112-36a304b66dad`.
2. Choose the **Web** platform and register your public HTTPS origin followed by `/auth/microsoft/callback`. For example, `https://crm.example.test/auth/microsoft/callback`. Harbor requests `openid profile email` for sign-in.
3. Copy the **Application (client) ID** and **Directory (tenant) ID** from the app's overview. Under **Certificates & secrets**, create a client secret and copy its **Value** into your installation's secret store. On Compose, use the private `.harbor/compose/web.env` created by the [self-host guide](self-host.md).
4. For manually managed accounts, open each teammate's entry in **Entra ID → Users** and copy that user's **Object ID** from the directory used for sign-in. Set `HARBOR_LOGIN_MICROSOFT_BINDINGS` to a JSON object mapping those IDs to their Harbor email addresses. Set `HARBOR_LOGIN_ALLOWED_EMAILS` for users who should have their own private workspaces. An invited guest needs a matching identity binding and an eligible invitation or grant. For company-managed accounts, follow the SCIM setup below.

Example Compose settings for two people follow. Fill the existing origin and allowlist entries, then add the Microsoft entries. Replace the placeholders, example IDs and addresses with your own. The single quotes around the JSON preserve its double quotes in the environment file.

```dotenv
HARBOR_LOGIN_ORIGIN=https://crm.example.test
HARBOR_LOGIN_MICROSOFT_TENANT_ID=<directory-tenant-id>
HARBOR_LOGIN_MICROSOFT_CLIENT_ID=<sign-in-application-client-id>
HARBOR_LOGIN_MICROSOFT_CLIENT_SECRET=<sign-in-client-secret-value>
HARBOR_LOGIN_ALLOWED_EMAILS=owner@example.test,rep@example.test
HARBOR_LOGIN_MICROSOFT_BINDINGS='{"11111111-1111-4111-8111-111111111111":"owner@example.test","22222222-2222-4222-8222-222222222222":"rep@example.test"}'
```

Apply the settings from the repository root. The doctor should report `ready` and `microsoftSignIn: ok`. Open Harbor in a fresh browser profile and choose **Continue with Microsoft**. Existing Google users can keep their original sign-in and connect their matching Outlook mailbox separately.

```sh
docker compose -f compose.portable.yaml run --rm web node scripts/portable-web.mjs doctor web --check-workspace-access
docker compose -f compose.portable.yaml up -d --wait web
```

To look up your own object ID, sign in to Microsoft Graph Explorer with the intended account and directory, then run `GET https://graph.microsoft.com/v1.0/me?$select=id` with `User.Read`. Use the returned user ID for the binding. [Microsoft’s user lookup](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0) · [Graph Explorer guide](https://learn.microsoft.com/en-us/graph/graph-explorer/graph-explorer-overview)

Microsoft documents each registration step. [Register an application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app) · [Configure a Web redirect URI](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri) · [Create a client secret](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials) · [ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)

## Provision workspace employees with SCIM

An organization using Microsoft sign-in can let its directory add employees to one workspace, set a viewer or editor role and withdraw access when an employee leaves. The local rehearsal uses a fictional tenant. A live provisioning cycle with an employer’s Entra tenant remains to be qualified.

1. Apply portable migrations through 0126. Configure organizational Microsoft sign-in as above. If the workspace owner uses Microsoft, pin their account. If the owner already signs in through Google or a pinned SAML account and all Microsoft users will be directory-managed, set the Microsoft bindings explicitly to `{}` and configure the workspace and domain in step 3 before restarting. Set `HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED=true`. Keep employees joining only as teammates off the deployment owner allowlist.
2. In the target workspace, open **Settings → Data management → API access → Token purpose → Manage Microsoft Entra employees**. Create a token and store it in the directory’s provisioning settings. Use `https://<your-harbor-host>/scim/v2` as the base URL and the token for bearer authentication. The workspace owner can revoke it from **API access**.
3. To onboard new hires without changing the server for each person, set `HARBOR_DIRECTORY_AUTHORITY_WORKSPACE_ID` to the target workspace’s ID and `HARBOR_DIRECTORY_EMAIL_DOMAIN` to the company’s exact email domain in the web service environment. Restart the web service. The signed-in owner can find that ID in the `owned` field of `GET /api/workspaces`. This explicitly trusts that workspace’s directory token to bind new employee addresses in that domain to their Microsoft directory object IDs. Operator addresses and existing sign-in bindings are protected. Leaving these settings empty allows directory assignment of individually pinned users only. With an empty bindings map, run the web doctor and check that both `microsoftSignIn` and `microsoftDirectoryAuthority` return `ok`. Provision one employee, verify they can open the intended workspace, then deactivate them and check their existing session.
4. Configure user provisioning. Map the Entra object ID to `externalId`, the employee’s company email address to `userName`, and employment status to `active`. Optionally send one core `roles` entry with `value` set to `viewer` or `editor`. Omit unused mappings. Start with one test assignment and inspect **Workspaces**. [Microsoft provisioning guide](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups)

Each Microsoft directory token works only with the Entra tenant configured when you create it. After switching tenants, issue a token for the new tenant. When upgrading from an earlier version, replace any token marked **Legacy Microsoft directory token** in your provisioning settings, run the directory’s connection test, and revoke the old token. Existing employees keep their workspace membership during rotation.

When the directory promotes a viewer to editor, the employee keeps their viewing scope and starts with edit access to their own records. A workspace administrator can grant broader editing in **Workspaces** after the promotion. Routine directory updates that keep the same role preserve that choice.

The `/Users` endpoint supports create, get, list, delete, and PATCH Replace for `active` and `roles`. Lists support an exact `userName eq "…"` or `externalId eq "…"` filter, `startIndex` and `count`, with up to 100 results per page. Repeat creates return a uniqueness conflict. Existing manual memberships require an explicit handover. The owner can review and adjust record scope, manual team assignments and file access in **Workspaces**.

Deactivation immediately removes the workspace grant and frees the seat. It also cuts off existing record and private-file links. Reactivation keeps the employee’s directory ID and issues a fresh grant with owned-record access. Prior team assignments, file access and administrator rights stay cleared. An optional role in the reactivation request sets the new role. Otherwise the employee returns as a viewer. The employee’s memberships in other workspaces are independent.

### Assign employees to Harbor teams

1. In **Workspaces → Teams and pods**, create or select a Harbor team. Enter the Entra group’s **Object ID** and choose **Link directory group**. Linking authorizes that group in this workspace. Employees keep their existing access until provisioning runs.
2. In the Entra enterprise application’s group attribute mappings, map `objectId` to `externalId` and use it as the matching attribute. Map `displayName` and `members`. Give the linked groups distinct names within this workspace, including when renaming them. Assign only the groups you linked. Provision the employees before sending their group membership. [Microsoft’s SCIM provisioning guide](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups)
3. Test one employee in a linked group. Open their entry in Harbor’s **Team directory** and check their primary team, role and record scope. To let a rep see a colleague’s team-owned records, choose the **team** viewing scope. A group assignment alone does not change that scope or make the rep an administrator.

Entra can include its additional User or Group schema identifier and resource metadata when it creates an employee or group. Harbor returns its core resource and supports the fields listed in its schema. [Microsoft’s provisioning request examples](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups#scim-protocol-requests-and-responses)

With a directory token, an operator can inspect the supported User and Group fields at `GET /scim/v2/Schemas`. Configure the attribute mappings explicitly for a custom Entra application.

Harbor supports one primary team per employee. Sync **direct user members** of each mapped group. A manual team assignment or a second mapped group produces a conflict. Resolve the existing assignment first, then sync again. Renaming the group updates its directory label and keeps the Harbor team name.

Directory clients can send incremental membership changes with `PATCH` or send a complete roster with `PUT /scim/v2/Groups/{id}`. With `PUT`, include the group’s display name and the desired `members` list. An empty list clears every directory-managed assignment in that group. Omitting `members` preserves the roster during a name-only update. If any member is ineligible, Harbor keeps both the previous name and roster.

Removing an employee from a group clears the team access it granted. A manual assignment to another employee stays in place. If the directory deletes a group, its Harbor mapping waits for provisioning again. Choose **Unlink directory group** to withdraw the owner’s authorization as well. After restoring a backup, explicitly recreate mappings and provision memberships before teammates use the restored workspace.

## Connect Outlook Mail and Calendar

Use a Microsoft account with an Outlook.com or Microsoft 365 mailbox. Register a second Web application for mailbox access, with its own client ID and secret. Choose the supported account type for the mailboxes you plan to connect. For a Microsoft 365 team in one directory, use its tenant ID. For personal Outlook.com mailboxes, use the consumer tenant ID listed above. Register both of these **Web** redirect URIs, replacing the example origin with your own.

```text
https://crm.example.test/api/outlook/mail/callback
https://crm.example.test/api/outlook/calendar/callback
```

On the Outlook registration, open **API permissions → Add a permission → Microsoft Graph → Delegated permissions**. Both connections need `User.Read` and `offline_access`. Mail requests `Mail.Read` for message previews. Calendar requests `Calendars.ReadBasic` for events and availability. Users choose Mail and Calendar separately. Tenant policy may require an administrator's consent. [Microsoft permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)

Set these values on the **web service**. Keep the secrets in the installation's private environment file or hosting secret manager.

| Web setting | Value |
| --- | --- |
| `HARBOR_PORTABLE_OUTLOOK_ENABLED` | `true` |
| `HARBOR_OUTLOOK_TENANT_ID` | The tenant ID for these connections |
| `HARBOR_OUTLOOK_CLIENT_ID`, `HARBOR_OUTLOOK_CLIENT_SECRET` | Credentials for the Outlook registration |
| `HARBOR_OUTLOOK_KEY` | A private base64-encoded 32-byte key. Generate one with `openssl rand -base64 32` and store it securely. |
| `HARBOR_OUTLOOK_CALENDAR_READ_EMAILS` | Optional comma-separated list of exact Harbor mailbox addresses to request the delegated `Calendars.Read` permission. The default is empty. Other users request `Calendars.ReadBasic`. |

With Compose, rerun the two commands above after editing `web.env`. Recreating the web container loads the new settings. The doctor reports `personalOutlook: ok` when the Outlook settings pass validation. In Harbor, open **Email settings → Personal Outlook Mail** or **Calendar → Personal Outlook Calendar**. Connect the Microsoft account whose primary address matches your Harbor email. Outlook credentials are encrypted in PostgreSQL, associated with the signed-in user, and excluded from Harbor recovery copies. Disconnecting takes effect in Harbor immediately. Microsoft's account portal also lets the user revoke the application's delegated consent.

**Check Outlook Mail connection** and **Check Outlook Calendar connection** verify that Microsoft accepts a read of the Inbox or default calendar. The check requests at most one item identifier. A mailbox can pass the account identity check while Microsoft denies access to its events.

If Microsoft denies basic calendar reads and the mailbox owner agrees to broader access, add the delegated `Calendars.Read` permission to the Outlook app registration, list that mailbox in `HARBOR_OUTLOOK_CALENDAR_READ_EMAILS`, and restart the web service. The permission allows reading full event details, including descriptions and attachments. Harbor continues to request only the fields used for availability and selected meeting logs. Switching a mailbox between permission levels requires a fresh personal connection. The user clicks **Check Outlook Calendar connection**, then **Reconnect Outlook Calendar** and reviews Microsoft’s consent screen. Mail uses its existing permission.

## Try the contact workflow

Open a private Contact that has an email address. Search **Received email** or **Past meetings** over a one- or seven-day window in the past year. Choose a result and log it on the Contact. Email excerpts are private previews. Harbor saves the subject and original activity time on the timeline and updates Last contacted. Confirm attendance before logging a past meeting. The search results are private to the connected user. The saved CRM activity follows the Contact's outreach permissions. After reloading the Contact, repeat the search and verify the selected item shows **Already recorded** and appears once on the timeline. For free/busy, open **Calendar → Check a time** and select Outlook if both calendars are connected.

Reads run when someone requests them. Background mailbox mirroring, Outlook sending, and creating or rescheduling Outlook events are outside this integration. To qualify an installation, sign in with a real tenant account, connect each service, log a known fictional message and completed meeting, check an occupied time, then disconnect and verify that fresh reads stop.

The live Railway walkthrough verified personal Outlook.com sign-in, receipt of a real reply, free/busy and selective logging of an ended test meeting. The guest's RSVP reached Outlook, and both activity timestamps survived a reload. An organizational Microsoft 365 mailbox still needs its own end-to-end check.
