ARG HARBOR_RUNTIME_IMAGE=harbor-portable:latest
FROM ${HARBOR_RUNTIME_IMAGE}

# Add fictional fixtures to the same runtime used for web, worker and recovery.
COPY --chown=node:node tests/ /app/tests/
COPY --chown=node:node scripts/check-standalone.mjs /app/scripts/
COPY --chown=node:node lib/ /app/lib/
COPY --chown=node:node db/postgres/ /app/db/postgres/
COPY --chown=node:node runtime/portable-invitation-acceptance.ts /app/runtime/
USER node
RUN npm ci --prefix tests/portable-fixtures --no-audit --no-fund \
    && ln -s portable-fixtures/node_modules tests/node_modules
CMD ["node", "tests/portable-fixtures/run.mjs"]
