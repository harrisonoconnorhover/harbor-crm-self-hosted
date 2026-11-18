# Harbor CRM

Harbor is a self-hosted CRM for teams. Manage contacts, companies, deals and tasks, share a pipeline and dashboards, and keep record history and file attachments in your own workspace.

## Install and try it

Follow the [self-host guide](docs/self-host.md) to build the Docker image, set up PostgreSQL 18, private S3-compatible storage and Google sign-in, and invite a second user. The web app and optional Notes worker use the same image. Each workspace supports 25 active members and pending invitations combined.

Start with fictional records. The guide walks through revoking a teammate, verifying a private file and restoring a matched database and file backup. Before using customer data, check your HTTPS setup, real identity provider, recovery time and operator alerts on your own installation.

## Test locally

With Docker and Git installed, run:

```sh
bash scripts/local-test.sh portable
```

The end-to-end suite starts PostgreSQL, simulated Google and private test file storage inside a network-isolated container. It checks sign-in, workspace permissions, the web app, background jobs and a second-instance recovery. Allow about 15 minutes after the build.

## Dependency status

On November 18, 2026, the production npm audit reported zero findings. The build toolchain still includes picomatch, for which an upstream fix was pending. The Docker image bundles the production HTTP server and removes the build tools. Build only trusted source and configuration. Run `npm audit --omit=dev` for runtime dependencies and `npm audit --include=dev` to include the build chain. [Upstream advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)

## License

Harbor’s original source is available under the [MIT License](LICENSE). [Third-party notices](THIRD_PARTY.md) describe the packages and embedded notice included with this distribution.
