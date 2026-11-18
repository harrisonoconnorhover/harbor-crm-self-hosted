#!/bin/sh
set -eu
umask 077

cd "$(dirname "$0")/.."
settings=.harbor/compose/web.env
mkdir -p .harbor/compose
if [ -e "$settings" ] || [ -L "$settings" ]; then
  echo "Keeping the existing $settings. See docs/self-host.md to continue."
  exit 0
fi

set -C
cat > "$settings" <<'SETTINGS'
# Fill in the web settings from your own installation.
# Single-quote values containing a literal dollar sign so Compose keeps it.
DATABASE_URL=
HARBOR_LOGIN_ORIGIN=
HARBOR_S3_ENDPOINT=
HARBOR_S3_BUCKET=
HARBOR_S3_ACCESS_KEY_ID=
HARBOR_S3_SECRET_ACCESS_KEY=
# HARBOR_S3_REGION=us-east-1
# HARBOR_S3_ADDRESSING=path-style

# For Microsoft sign-in or personal Outlook connections see docs/microsoft-outlook.md.
# For Google sign-in fill in the client after the preflight gives you the callback URL.
HARBOR_LOGIN_GOOGLE_CLIENT_ID=
HARBOR_LOGIN_GOOGLE_CLIENT_SECRET=
HARBOR_LOGIN_ALLOWED_EMAILS=
SETTINGS
echo "Created $settings. Follow docs/self-host.md to configure the web app."
