ARG HARBOR_RUNTIME_IMAGE=harbor-portable:latest
FROM ${HARBOR_RUNTIME_IMAGE}

# Add fictional fixtures to the same runtime used for web, worker and recovery.
COPY --chown=node:node tests/ /app/tests/
COPY --chown=node:node scripts/check-standalone.mjs /app/scripts/
COPY --chown=node:node lib/public-pilot-contact.mjs /app/lib/
COPY --chown=node:node runtime/portable-invitation-acceptance.ts /app/runtime/
USER node
RUN npm ci --prefix tests/portable-fixtures --no-audit --no-fund
CMD ["node", "tests/portable-fixtures/run.mjs"]
