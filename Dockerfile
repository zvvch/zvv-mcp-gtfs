FROM node:20-slim

# Build-Dependencies für better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies installieren
COPY package*.json ./
RUN npm install --production

# Quellcode kopieren
COPY . .

# GTFS-Daten herunterladen und in SQLite importieren
RUN node download-gtfs.js && node import-gtfs.js

# Port freigeben
EXPOSE 3000

# Health-Check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://localhost:3000/health', r => { process.exit(r.statusCode === 200 ? 0 : 1) })"

# Server starten
CMD ["node", "server.js"]
