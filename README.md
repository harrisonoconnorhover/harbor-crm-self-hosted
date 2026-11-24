# Harbor CRM

Harbor is a self-hosted CRM for teams. Manage contacts, companies, deals and tasks, share a pipeline and dashboards, and keep record history and file attachments in your own workspace.

## Try Harbor locally

With Docker running, open a terminal in this checkout and run:

```sh
sh scripts/demo.sh
```

Open the local link the command prints and choose **Try as a sales rep**. Open the North Pier spring order, read its latest note, and complete the follow-up task. Return to the role chooser and open the same deal as the manager. The demo uses fictional accounts and keeps its data on your computer. To stop it and discard the demo workspace, run `sh scripts/demo.sh stop`.

## Install for your team

The [single-host installation guide](docs/team-install.md) sets up Harbor, PostgreSQL, private file storage, and HTTPS with Docker Compose. Bring a domain and your team's sign-in provider. If you already operate a database and bucket, follow the [existing infrastructure guide](docs/self-host.md).

For a Microsoft 365 team or personal Outlook.com mailbox, the [Microsoft sign-in and Outlook guide](docs/microsoft-outlook.md) covers app registration, individual consent, and logging a selected email or completed meeting on a contact.

For a company identity provider, follow the [OpenID Connect and SAML sign-in guide](docs/saml.md).

Teams keeping Salesforce can use [Harbor for email marketing and website forms](docs/marketing.md).

Start with fictional records. The guide walks through revoking a teammate, verifying a private file and restoring a matched database and file backup. Before using customer data, check your HTTPS setup, real identity provider, recovery time and operator alerts on your own installation.

## Test locally

With Docker and Git installed, run:

```sh
bash scripts/local-test.sh portable
```

The end-to-end suite starts PostgreSQL, simulated identity and mail providers, and private test file storage inside a network-isolated container. It checks sign-in, workspace permissions, the web app, background jobs and a second-instance recovery. Allow about 15 minutes after the build.

### Rehearse a fictional sales week

Follow two reps and their manager from CSV import through a shared deal, a forecast review, offboarding and recovery of a private attachment on a second instance. This local rehearsal uses simulated identities and disposable storage.

On macOS or Linux, use Node 22.13 or later, OpenSSL, PostgreSQL 18 client tools, and Playwright with Chromium. Run as a regular user. If the PostgreSQL tools are outside your PATH, set `HARBOR_TEST_PG_BIN` to their bin directory. For an existing Playwright installation, set `HARBOR_TEST_PLAYWRIGHT` to its absolute `index.mjs` path. Set `HARBOR_TEST_CHROME` if using a separately installed Chrome executable.

```sh
npm ci
npm ci --prefix tests/portable-fixtures
npm run build:portable
node tests/portable-fixtures/run.mjs --sales-week
```

## Dependency status

Run `npm audit --omit=dev` for the production dependency tree and `npm audit --include=dev` for the build toolchain. The Dockerfile bundles the production HTTP server and removes the development dependencies from the runtime image. Build from source and configuration you trust.

## License

Harbor’s original source is available under the [MIT License](LICENSE). [Third-party notices](THIRD_PARTY.md) describe the packages and embedded notice included with this distribution.
