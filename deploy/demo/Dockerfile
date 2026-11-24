FROM harbor-demo-runtime
COPY --chown=node:node tests/portable-fixtures/package*.json /app/deploy/demo/
RUN npm ci --prefix /app/deploy/demo --no-audit --no-fund
COPY --chown=node:node deploy/demo/*.mjs /app/deploy/demo/
CMD ["node", "deploy/demo/start.mjs"]
