# Microsoft sign-in and Outlook for self-hosted Harbor

Portable Harbor supports Microsoft sign-in and two optional personal connections. A team can use Google sign-in and connect Outlook, use Microsoft sign-in on its own, or offer both sign-in buttons. Connections are available in a user's private workspace. A workspace administrator cannot connect a teammate's mailbox for them.

## Sign in with Microsoft

1. In **Microsoft Entra ID → App registrations → New registration**, create a sign-in app for this Harbor installation. For one Microsoft 365 organization, choose **Accounts in this organizational directory only**. For personal Microsoft accounts, choose a registration that supports them and use Microsoft's consumer tenant ID `9188040d-6c67-4c5b-b112-36a304b66dad`.
2. Choose the **Web** platform and register your public HTTPS origin followed by `/auth/microsoft/callback`. For example, `https://crm.example.test/auth/microsoft/callback`. Harbor requests `openid profile email` for sign-in.
3. Copy the **Application (client) ID** and **Directory (tenant) ID** from the app's overview. Under **Certificates & secrets**, create a client secret and copy its **Value** into your installation's secret store. On Compose, use the private `.harbor/compose/web.env` created by the [self-host guide](self-host.md).
4. In **Entra ID → Users**, open each teammate's account and copy that user's **Object ID** from the directory used for sign-in. Set `HARBOR_LOGIN_MICROSOFT_BINDINGS` to a JSON object mapping those IDs to their Harbor email addresses. Set `HARBOR_LOGIN_ALLOWED_EMAILS` for users who should have their own private workspaces. An invited guest also needs a matching identity binding and an eligible invitation or grant.

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
