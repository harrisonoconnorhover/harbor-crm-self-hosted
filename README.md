# Harbor CRM

Harbor is a self-hosted CRM for teams. Manage contacts, companies, deals and tasks, share a pipeline and dashboards, and keep record history and file attachments in your own workspace.

## Install and try it

Follow the [self-host guide](docs/self-host.md) to build the Docker image, set up PostgreSQL 18, private S3-compatible storage and your sign-in provider, and invite a second user. The web app and optional Notes worker use the same image. The self-host guide explains how active teammates and pending invitations count toward the workspace seat limit.

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

## Dependency status

Run `npm audit --omit=dev` for the production dependency tree and `npm audit --include=dev` for the build toolchain. The Dockerfile bundles the production HTTP server and removes the development dependencies from the runtime image. Build from source and configuration you trust.

## License

Harbor’s original source is available under the [MIT License](LICENSE). [Third-party notices](THIRD_PARTY.md) describe the packages and embedded notice included with this distribution.
