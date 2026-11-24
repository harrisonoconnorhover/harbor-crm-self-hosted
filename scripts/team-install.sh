#!/bin/sh
set -eu
umask 077

cd "$(dirname "$0")/.."
settings=.harbor/team
usage() {
  echo "Usage: sh scripts/team-install.sh init crm.example.com | start | status | stop | compose <args>" >&2
  exit 2
}
compose() (
  unset HARBOR_IMAGE HARBOR_HOST
  docker compose --env-file "$settings/compose.env" -f compose.team.yaml "$@"
)

case "${1:-}" in
  init)
    [ "$#" -eq 2 ] || usage
    domain=$2
    if ! printf '%s\n' "$domain" | LC_ALL=C grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$' ||
       [ "${#domain}" -gt 253 ] || [ "$(printf '%s' "$domain" | wc -l | tr -d ' ')" != 0 ]; then
      echo 'Supply the DNS hostname only, for example crm.example.com.' >&2
      exit 2
    fi
    release=$(git rev-parse --short=12 HEAD)
    db_admin=$(openssl rand -hex 32)
    db_app=$(openssl rand -hex 32)
    access_key=$(openssl rand -hex 12)
    secret_key=$(openssl rand -hex 32)
    mkdir -p .harbor
    if ! mkdir "$settings"; then
      echo "Keeping existing settings. See docs/team-install.md before changing this installation." >&2
      exit 1
    fi
    cat > "$settings/compose.env" <<SETTINGS
HARBOR_HOST=$domain
HARBOR_IMAGE=harbor-team:$release
SETTINGS
    cat > "$settings/postgres.env" <<SETTINGS
POSTGRES_DB=harbor
POSTGRES_PASSWORD=$db_admin
HARBOR_DB_PASSWORD=$db_app
SETTINGS
    cat > "$settings/web.env" <<SETTINGS
DATABASE_URL=postgresql://harbor:$db_app@postgres:5432/harbor
HARBOR_LOGIN_ORIGIN=https://$domain
HARBOR_S3_ENDPOINT=https://files
HARBOR_S3_BUCKET=harbor-files
HARBOR_S3_ACCESS_KEY_ID=$access_key
HARBOR_S3_SECRET_ACCESS_KEY=$secret_key
SETTINGS
    cat > "$settings/s3.json" <<SETTINGS
{"identities":[{"name":"harbor","credentials":[{"accessKey":"$access_key","secretKey":"$secret_key"}],"actions":["Read:harbor-files","List:harbor-files","Write:harbor-files"]}]}
SETTINGS
    cat > "$settings/identity.env" <<'SETTINGS'
# Enter the initial workspace owner's email. Use single quotes around values containing $.
HARBOR_LOGIN_ALLOWED_EMAILS=
# Choose your provider. See docs/team-install.md for Microsoft or company sign-in.
HARBOR_LOGIN_GOOGLE_CLIENT_ID=
HARBOR_LOGIN_GOOGLE_CLIENT_SECRET=
SETTINGS
    echo "Settings created. Configure $settings/identity.env."
    echo "Google web callback: https://$domain/auth/google/callback"
    echo "Then run: sh scripts/team-install.sh start"
    ;;
  start)
    [ "$#" -eq 1 ] || usage
    # Pin the source build from init. An upgrade needs a separate backup and migration window.
    release=$(git rev-parse --short=12 HEAD)
    if ! grep -qx "HARBOR_IMAGE=harbor-team:$release" "$settings/compose.env"; then
      echo 'The checkout differs from the initialized release. Follow the upgrade procedure in docs/team-install.md.' >&2
      exit 1
    fi
    # The public certificate is copied after the storage proxy starts.
    touch "$settings/storage-ca.crt"
    compose config --quiet
    if ! docker image inspect "harbor-team:$release" >/dev/null 2>&1; then
      docker build -t "harbor-team:$release" .
    fi
    compose up -d --wait postgres objects files
    compose exec -T files cat /data/caddy/pki/authorities/local/root.crt > "$settings/storage-ca.crt.new"
    chmod 644 "$settings/storage-ca.crt.new"
    recreate_web=
    if cmp -s "$settings/storage-ca.crt" "$settings/storage-ca.crt.new"; then
      rm "$settings/storage-ca.crt.new"
    else
      mv "$settings/storage-ca.crt.new" "$settings/storage-ca.crt"
      recreate_web=--force-recreate
    fi
    compose run --rm --no-deps web node scripts/portable-web.mjs migrate
    compose run --rm --no-deps web node scripts/portable-web.mjs doctor web --check-workspace-access
    compose up -d --wait $recreate_web web
    compose up -d --wait gateway
    host=$(sed -n 's/^HARBOR_HOST=//p' "$settings/compose.env")
    echo "Open https://$host and sign in."
    ;;
  compose) shift; compose "$@" ;;
  status) compose ps ;;
  stop) compose stop ;;
  *) usage ;;
esac
