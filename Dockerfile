FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --include=optional --no-audit --no-fund
COPY . .
RUN npm run build:portable && npm prune --omit=dev --no-audit --no-fund

FROM postgres:18-bookworm AS postgres-repo

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PATH="/usr/lib/postgresql/18/bin:${PATH}"

# Backup and restore use the same release image as the web and worker processes.
COPY --from=postgres-repo /usr/local/share/keyrings/postgres.gpg.asc /usr/local/share/keyrings/
COPY --from=postgres-repo /etc/apt/sources.list.d/pgdg.list /tmp/pgdg.list
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && sed 's|http://apt.postgresql.org|https://apt.postgresql.org|' /tmp/pgdg.list > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/* /tmp/pgdg.list

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.harbor/portable-build ./.harbor/portable-build
COPY --from=build --chown=node:node /app/db/postgres/migrations ./db/postgres/migrations
COPY --from=build --chown=node:node /app/runtime/portable-config.mjs /app/runtime/portable-migrations.mjs /app/runtime/portable-web.mjs ./runtime/
COPY --from=build --chown=node:node /app/scripts/portable-web.mjs ./scripts/portable-web.mjs
USER node
CMD ["node", "scripts/portable-web.mjs", "start"]
