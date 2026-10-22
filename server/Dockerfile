# Build from the repository root:
#   docker build -f server/Dockerfile -t qqpet-server .
# The server imports the shared runtime/protocol sources from ../src at build time.
FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY server ./server
RUN npm --prefix server run build \
    && npm --prefix server prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    QQPET_SYNC_BIND=0.0.0.0 \
    QQPET_SYNC_PORT=8787 \
    QQPET_SYNC_DB=/var/lib/qqpet-sync/qqpet.sqlite \
    QQPET_SYNC_BACKUP_DIR=/var/lib/qqpet-sync/backups \
    QQPET_SYNC_LOG_LEVEL=info
WORKDIR /opt/qqpet-sync
COPY --from=build --chown=node:node /build/server/package.json ./package.json
COPY --from=build --chown=node:node /build/server/node_modules ./node_modules
COPY --from=build --chown=node:node /build/server/dist ./dist
RUN install -d -o node -g node -m 0700 /var/lib/qqpet-sync /var/lib/qqpet-sync/backups
USER node:node
EXPOSE 8787
VOLUME ["/var/lib/qqpet-sync"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r => { if (r.ok === false) process.exit(1) }).catch(() => process.exit(1))"
ENTRYPOINT ["node", "dist/server/src/index.js"]
CMD ["start"]
