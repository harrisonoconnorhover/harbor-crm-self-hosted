# Self-host Harbor

Install Harbor on a **new, empty database**, then verify that two teammates can share a record. For an existing installation, [take a matched backup before upgrading](#back-up-and-recover).

## What you bring

| Resource | What Harbor needs |
| --- | --- |
| Docker host with Compose | An HTTPS reverse proxy on that host pointing to `127.0.0.1:8787`. Configure it to overwrite the forwarded host and scheme. |
| PostgreSQL 18 | An empty UTF-8 database on a private network reachable from the web container. |
| File storage | A private S3-compatible bucket with an HTTPS endpoint. The web credential needs bucket checks and object read/write access. |
| Google sign-in | A Google web application client for this installation and two accounts you can use to try sharing. Sign-in only uses name, email and profile. |

Supply your own database, bucket and identity client. The same Compose setup works independently of Railway.

## 1. Prepare the web app

From the repository root:

```sh
sh scripts/init-portable-compose.sh
export HARBOR_IMAGE="harbor-portable:$(git rev-parse --short HEAD)"
docker build -t "$HARBOR_IMAGE" .
```

Open `.harbor/compose/web.env` in your editor. The setup command leaves an existing file alone. Enter the web database URL, your exact HTTPS origin without a trailing slash, and the bucket settings. If your provider puts the bucket in the hostname, use `HARBOR_S3_ADDRESSING=virtual-hosted` and enter the base endpoint **without** the bucket name. Leave the three Google settings empty for now.

```sh
docker compose -f compose.portable.yaml config --quiet
docker compose -f compose.portable.yaml run --rm web node scripts/portable-web.mjs migrate
docker compose -f compose.portable.yaml run --rm web node scripts/portable-web.mjs doctor web --before-google
```

The first command checks the Compose file without printing its secrets. Migration creates the tables. If the web account cannot create tables, set the migration role’s `DATABASE_URL` in your shell and use `docker compose -f compose.portable.yaml run --rm -e DATABASE_URL web node scripts/portable-web.mjs migrate`. Keep the normal web role in the file. Continue when the doctor reports `ready_for_google_setup`. It checks the database and bucket and prints `googleCallbackUrl`.

### If your provider uses an internal certificate authority

Place the CA's public PEM certificate in `.harbor/compose/company-ca.pem`. It must be readable by the container's `node` user. Save this override as `.harbor/compose/trust.yaml` and add `-f .harbor/compose/trust.yaml` after the base Compose file whenever running a Compose command for this installation. Apply the same mount and settings to workers or backup jobs that connect to the same provider.

```yaml
services:
  web:
    volumes:
      - ./.harbor/compose/company-ca.pem:/run/harbor/company-ca.pem:ro
    environment:
      NODE_EXTRA_CA_CERTS: /run/harbor/company-ca.pem
```

For PostgreSQL with this CA, set `sslmode=verify-full` in the database URL and `PGSSLROOTCERT=/run/harbor/company-ca.pem` for its command-line tools.

## 2. Sign in and invite a teammate

Register that exact callback as an authorized redirect URI for your Google web client. In `web.env`, enter its client ID and secret, then set `HARBOR_LOGIN_ALLOWED_EMAILS` to the two Google email addresses separated by a comma. If your Google app is in testing, include both accounts as test users.

```sh
docker compose -f compose.portable.yaml run --rm web node scripts/portable-web.mjs doctor web --check-workspace-access
docker compose -f compose.portable.yaml up -d --wait web
```

Expect `ready`, then open your **public HTTPS address** and choose **Continue with Google**. Only the web app starts.

1. As the owner, create a fictional Contact. Under **Workspaces**, enter the other account, choose **Viewer**, and select **Prepare invitation**. Copy the invitation link and share it yourself.
2. Open the link in a separate browser profile as the teammate. Accept, open the shared workspace and find the Contact. Confirm a Viewer can read it but cannot edit it.
3. As the owner, change the role to **Editor**. Refresh the teammate's page, change a property and confirm the owner sees the change. Revoke access, then reload the same shared record as the teammate and confirm access is gone.

## Check the team experience

- Upload and download a fictional private attachment. Sign in as a teammate who lacks file access and confirm the download is denied.
- Appoint an Editor as **Backup administrator** in **Workspaces → Team directory**. Have that person invite and revoke a fictional member from their own login. The owner controls private connections, imports and dashboard publishing.
- Share a dashboard, open it from the teammate's workspace, then use **Find in Harbor** to find a shared record. On the owner's Contacts list use **Import / export** to preview a matched CSV update before applying it.
- For a timed task, choose a reminder and open the reminder tray as its assignee. Reminders appear inside Harbor.

The workspace limit is **25 active teammates and pending invitations combined**. Rehearse with your own expected record counts and number of simultaneous users.

### Check that files are private

Upload a nonempty fictional attachment and copy its exact object key from the bucket's management console. Run this with that key:

```sh
docker compose -f compose.portable.yaml run --rm web node scripts/portable-web.mjs doctor web --check-file-privacy 'your-fictional-object-key'
```

Look for `"filePrivacy": "ok"`: Harbor confirmed the object exists using its own credentials, then the bucket denied an anonymous read. Repeat the anonymous read on any public alias or CDN configured for the bucket. An unsigned request for that existing file should receive HTTP 401 or 403.

## Optional Notes worker

Create `.harbor/compose/worker.env` with permissions restricted to the operator and a `DATABASE_URL` for the same database. Pass both Compose files to run scheduled Notes. Use the same image tag as the web app.

```sh
docker compose -f compose.portable.yaml -f compose.portable.notes-only.yaml run --rm worker node scripts/portable-web.mjs doctor worker
docker compose -f compose.portable.yaml -f compose.portable.notes-only.yaml up -d worker
docker compose -f compose.portable.yaml -f compose.portable.notes-only.yaml exec worker node scripts/portable-web.mjs worker-status --expect-worker
```

Look for `notes-only` in the worker's startup log. Schedule a fictional Note, close the browser, then reopen the record after its due time and verify a single completed entry. The base Compose file also supports full job processing. Review your enabled workflows and provider connections before selecting that mode.

## Back up and recover

For an upgrade, pause the web app, worker and any backup process after active work finishes. Use the current image to take a recoverable copy of PostgreSQL **and** the matching attachment bytes. Keep the old image and store the bundle outside the live host.

Run the following inside a one-off Harbor container with the source database and bucket settings. Mount a private directory at `/backups` writable by the container's `node` user. Replace the example database and bucket names with the configured names and choose a new bundle directory.

```sh
node scripts/portable-web.mjs backup /backups/pre-upgrade --source source_db source_bucket
node scripts/portable-web.mjs doctor bundle /backups/pre-upgrade
```

For a recovery rehearsal, configure the same image with a **different, empty database and private bucket**. Keep the destination web app and worker stopped. Mount the verified bundle read-only. In the destination container run:

```sh
node scripts/portable-web.mjs doctor restore --bundle /backups/pre-upgrade
HARBOR_PORTABLE_RESTORE_ENABLED=true node scripts/portable-web.mjs restore /backups/pre-upgrade --target recovery_db recovery_bucket
node scripts/portable-web.mjs migrate
```

Use the destination's real database and bucket names for the two target arguments. Start its web app, sign in again and verify a linked record and both versions of a replaced attachment. Check that each file matches its expected contents. Regrant workspace access as needed. Keep jobs off on the restored instance while the original is processing work.

Before storing customer data, schedule backups on private persistent storage and verify that an alert from your monitoring system reaches an operator. The [Compose profiles](../compose.portable.yaml) define the backup and monitor processes. [Prometheus rules](../deploy/portable-prometheus.rules.yml) and [rule tests](../deploy/portable-prometheus.test.yml) are included.
