# Install Harbor for your team on one Docker host

This recipe provides Harbor, PostgreSQL 18, a private SeaweedFS bucket, and Caddy for HTTPS. Bring a domain, a sign-in provider, and a host with Docker Compose v2, Git, and OpenSSL. Point the domain's DNS at the host. If the domain has an IPv6 record, it must reach the host too. Allow inbound TCP 80 and 443. Harbor's PostgreSQL and file services publish no host ports.

Already operating Postgres, private object storage, or an HTTPS proxy? Use the [existing infrastructure recipe](self-host.md) with your own endpoints.

## First installation

Use a new host or Docker Compose project for this installation. From the repository root, replace the example with your domain.

```sh
sh scripts/team-install.sh init crm.example.com
```

The command generates separate database administrator, application, and bucket credentials in the Git-ignored, owner-only directory `.harbor/team/`. Run it once. Repeating it preserves existing credentials and exits with a message. Keep a private copy of this directory along with your recovery materials.

Open `.harbor/team/identity.env` in your editor. Set `HARBOR_LOGIN_ALLOWED_EMAILS` to the owner's address and the second test user's address, separated by a comma. This gives each of them a private workspace. To admit other teammates only by invitation, enable `HARBOR_PORTABLE_INVITE_SIGN_IN_ENABLED=true` after configuring a supported provider and its allowed users. Choose one sign-in option.

- **Google.** Register a Web OAuth client with the exact callback printed by the installer, such as `https://crm.example.com/auth/google/callback`. Enter its client ID and secret. Add the initial users to Google's test audience if your app is in testing.
- **Microsoft.** Follow the [Microsoft sign-in instructions](microsoft-outlook.md). Put the Microsoft identity settings in this same file and leave the Google client fields empty.
- **Company SSO.** Use your identity provider's [OpenID Connect or SAML settings](saml.md) in this file. Leave unused provider settings empty.

Start the team installation:

```sh
sh scripts/team-install.sh start
```

This builds the current release on the first run, starts storage, migrates the database, checks storage, sign-in configuration and workspace access, and starts Harbor. Caddy obtains and renews the public certificate. The private file endpoint has a separate internal certificate. Harbor receives the public part of the storage certificate authority to verify its connection.

Open your HTTPS address, sign in, create a fictional contact, and upload a file. Invite a teammate from **Workspaces**, accept in a second browser, and check access to the contact and attachment. Sign-in configuration checks cannot complete consent for a real person. See the [self-host guide](self-host.md) for the team and file checks.

## Operate the installation

```sh
sh scripts/team-install.sh status
sh scripts/team-install.sh compose logs --tail=50 gateway web
sh scripts/team-install.sh stop
sh scripts/team-install.sh start
```

Stop and start preserve named volumes. Keep the same project name and settings. This initial recipe serves interactive CRM and leaves unattended jobs off. Before using real data, arrange off-host backups and an operator alert, then restore a backup to a second instance and check its linked records and attachments. A single host is one failure domain.

For a release upgrade, finish active work and stop the gateway and web app with `sh scripts/team-install.sh compose stop gateway web`. Leave the database and file services running. With the old image, [capture and check a matched database-and-file backup](self-host.md) using source database `harbor` and bucket `harbor-files`. Mount your private backup directory when running one-off commands, for example:

```sh
sh scripts/team-install.sh compose run --rm --no-deps -v /absolute/private/backup-dir:/backups web node scripts/portable-web.mjs backup /backups/pre-upgrade --source harbor harbor-files
sh scripts/team-install.sh compose run --rm --no-deps -v /absolute/private/backup-dir:/backups:ro web node scripts/portable-web.mjs doctor bundle /backups/pre-upgrade
```

The backup directory must be writable by the image's node user. Keep the old image and backup. After checking out the intended revision, set `HARBOR_IMAGE` in `.harbor/team/compose.env` to `harbor-team:` followed by the output of `git rev-parse --short=12 HEAD`. Run `sh scripts/team-install.sh start` to build, migrate, and check it. On failure, review the reported check before reopening to users. For an incompatible migration use the old release with a matched restore to separate storage.
