# syntax=docker/dockerfile:1

# ── Build-Stage: native Module (better-sqlite3) kompilieren ──────
FROM node:22-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

# ── Runtime-Stage: schlankes Image ohne Build-Toolchain ──────────
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js mcp-tools.js download-gtfs.js import-gtfs.js check-update.js ./
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /app/zvv-data/gtfs \
    && chown -R node:node /app/zvv-data

# GTFS-Rohdaten (~2.9 GB) und SQLite-DB (~5.3 GB) leben im Volume,
# nicht im Image. Das haelt das Image klein und die Daten aktualisierbar.
VOLUME ["/app/zvv-data"]

USER node
EXPOSE 3000

# Erstaufbau der DB dauert ~10 Minuten, daher grosszuegige start-period.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20m --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "server.js"]
