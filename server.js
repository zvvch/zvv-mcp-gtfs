const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// --- Konfiguration ---
const PORT = parseInt(process.env.PORT, 10) || 3000;
const DB_PATH = process.env.GTFS_DB_PATH || path.join(__dirname, 'zvv-data', 'gtfs.db');

// --- Datenbank ---
let db;

function getDb() {
  if (!db) {
    if (!fs.existsSync(DB_PATH)) {
      throw new Error(`SQLite-Datenbank nicht gefunden: ${DB_PATH}. Zuerst 'npm run build' ausführen.`);
    }
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
    db.pragma('cache_size = -32000');
  }
  return db;
}

// --- Hilfsfunktionen ---

/** Gibt DB-Statistiken zurück */
function getDbStats() {
  const d = getDb();
  const tables = d.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'"
  ).all();

  const stats = {};
  for (const { name } of tables) {
    const row = d.prepare(`SELECT COUNT(*) as count FROM "${name}"`).get();
    stats[name] = row.count;
  }
  return stats;
}

/** Holt Metadaten aus der _meta-Tabelle */
function getMeta() {
  const d = getDb();
  try {
    const rows = d.prepare('SELECT key, value FROM _meta').all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  } catch {
    return {};
  }
}

// --- MCP Server erstellen ---
function createMcpServer() {
  const server = new McpServer({
    name: 'ZVV GTFS MCP Server',
    version: '2.0.0'
  });

  // === TOOLS ===

  // 1. search_stops - Haltestellen suchen
  server.tool(
    'search_stops',
    'Sucht Haltestellen nach Name. Gibt stop_id, stop_name, Koordinaten und Typ zurück.',
    {
      query: z.string().describe('Suchbegriff für Haltestellenname'),
      limit: z.number().int().min(1).max(100).default(20).describe('Maximale Anzahl Ergebnisse')
    },
    async ({ query, limit }) => {
      const d = getDb();
      const results = d.prepare(`
        SELECT stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station
        FROM stops
        WHERE stop_name LIKE ?
        ORDER BY
          CASE WHEN stop_name LIKE ? THEN 0 ELSE 1 END,
          stop_name
        LIMIT ?
      `).all(`%${query}%`, `${query}%`, limit);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: results.length,
            stops: results
          }, null, 2)
        }]
      };
    }
  );

  // 2. get_routes - Linien abrufen
  server.tool(
    'get_routes',
    'Gibt ÖV-Linien zurück. Optional filterbar nach Agentur oder Linientyp (0=Tram, 1=Metro, 2=Bahn, 3=Bus, 4=Fähre, 6=Gondel, 7=Standseilbahn).',
    {
      agency_id: z.string().optional().describe('Filter nach Verkehrsunternehmen (agency_id)'),
      route_type: z.number().int().optional().describe('Filter nach Linientyp (GTFS route_type)'),
      limit: z.number().int().min(1).max(500).default(50).describe('Maximale Anzahl Ergebnisse')
    },
    async ({ agency_id, route_type, limit }) => {
      const d = getDb();
      let sql = `
        SELECT r.route_id, r.route_short_name, r.route_long_name, r.route_type,
               r.agency_id, a.agency_name
        FROM routes r
        LEFT JOIN agency a ON r.agency_id = a.agency_id
        WHERE 1=1
      `;
      const params = [];

      if (agency_id) {
        sql += ' AND r.agency_id = ?';
        params.push(agency_id);
      }
      if (route_type !== undefined) {
        sql += ' AND r.route_type = ?';
        params.push(route_type);
      }
      sql += ' ORDER BY r.route_short_name LIMIT ?';
      params.push(limit);

      const results = d.prepare(sql).all(...params);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: results.length,
            routes: results
          }, null, 2)
        }]
      };
    }
  );

  // 3. get_departures - Abfahrten ab Haltestelle
  server.tool(
    'get_departures',
    'Gibt Abfahrten von einer Haltestelle zurück. Zeigt Linie, Richtung und Abfahrtszeit. Löst Parent-Stations automatisch auf (inkl. aller Gleise/Perrons). Ohne time_from werden Abfahrten ab JETZT angezeigt.',
    {
      stop_id: z.string().describe('Haltestellen-ID (stop_id)'),
      date: z.string().optional().describe('Datum im Format YYYYMMDD (default: heute)'),
      time_from: z.string().optional().describe('Startzeit im Format HH:MM:SS (default: aktuelle Uhrzeit). Für Abfahrten ab sofort weglassen.'),
      limit: z.number().int().min(1).max(200).default(30).describe('Maximale Anzahl Ergebnisse')
    },
    async ({ stop_id, date, time_from, limit }) => {
      const d = getDb();

      // Aktives Datum bestimmen
      const targetDate = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const dateObj = new Date(
        parseInt(targetDate.slice(0, 4)),
        parseInt(targetDate.slice(4, 6)) - 1,
        parseInt(targetDate.slice(6, 8))
      );
      const dayCol = dayOfWeek[dateObj.getDay()];

      // Default: aktuelle Schweizer Zeit (CET/CEST), nicht Mitternacht
      const nowSwiss = new Date().toLocaleTimeString('de-CH', {
        timeZone: 'Europe/Zurich', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      const startTime = time_from || nowSwiss;

      // Schweizer GTFS Stop-ID Aufloesung:
      // Parent8503000 = Eltern-Station, 8503000 = Station, 8503000:0:1 = Gleis
      // Wir muessen alle verwandten Stops finden, egal welche ID uebergeben wird.
      const relatedStops = d.prepare(`
        SELECT DISTINCT stop_id FROM stops
        WHERE stop_id = ?
           OR parent_station = ?
           OR parent_station = ('Parent' || ?)
           OR stop_id LIKE (? || ':%')
           OR parent_station = (SELECT parent_station FROM stops WHERE stop_id = ? AND parent_station IS NOT NULL AND parent_station != '')
      `).all(stop_id, stop_id, stop_id, stop_id, stop_id).map(r => r.stop_id);

      // Original stop_id immer einschliessen
      if (!relatedStops.includes(stop_id)) relatedStops.push(stop_id);

      const stopPlaceholders = relatedStops.map(() => '?').join(',');

      const results = d.prepare(`
        SELECT
          st.departure_time,
          st.arrival_time,
          st.stop_sequence,
          t.trip_id,
          t.trip_headsign,
          t.direction_id,
          r.route_short_name,
          r.route_long_name,
          r.route_type,
          a.agency_name
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        JOIN routes r ON t.route_id = r.route_id
        LEFT JOIN agency a ON r.agency_id = a.agency_id
        WHERE st.stop_id IN (${stopPlaceholders})
          AND st.departure_time >= ?
          AND (
            -- Fall 1: Service aktiv via calendar (Basis-Fahrplan)
            (
              t.service_id IN (
                SELECT service_id FROM calendar
                WHERE ${dayCol} = 1
                  AND start_date <= ?
                  AND end_date >= ?
              )
              AND t.service_id NOT IN (
                SELECT service_id FROM calendar_dates
                WHERE date = ? AND exception_type = 2
              )
            )
            OR
            -- Fall 2: Service explizit hinzugefuegt via calendar_dates
            t.service_id IN (
              SELECT service_id FROM calendar_dates
              WHERE date = ? AND exception_type = 1
            )
          )
        ORDER BY st.departure_time
        LIMIT ?
      `).all(...relatedStops, startTime, targetDate, targetDate, targetDate, targetDate, limit);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            stop_id,
            date: targetDate,
            time_from: startTime,
            count: results.length,
            departures: results
          }, null, 2)
        }]
      };
    }
  );

  // 4. get_trip_details - Fahrt-Details
  server.tool(
    'get_trip_details',
    'Gibt alle Details einer Fahrt zurück: Route, alle Halte mit Zeiten in Reihenfolge.',
    {
      trip_id: z.string().describe('Fahrt-ID (trip_id)')
    },
    async ({ trip_id }) => {
      const d = getDb();

      const trip = d.prepare(`
        SELECT t.trip_id, t.trip_headsign, t.direction_id, t.service_id,
               r.route_short_name, r.route_long_name, r.route_type,
               a.agency_name
        FROM trips t
        JOIN routes r ON t.route_id = r.route_id
        LEFT JOIN agency a ON r.agency_id = a.agency_id
        WHERE t.trip_id = ?
      `).get(trip_id);

      if (!trip) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Fahrt '${trip_id}' nicht gefunden.` }) }],
          isError: true
        };
      }

      const stops = d.prepare(`
        SELECT st.stop_sequence, st.arrival_time, st.departure_time,
               s.stop_id, s.stop_name, s.stop_lat, s.stop_lon
        FROM stop_times st
        JOIN stops s ON st.stop_id = s.stop_id
        WHERE st.trip_id = ?
        ORDER BY st.stop_sequence
      `).all(trip_id);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            trip,
            stop_count: stops.length,
            stops
          }, null, 2)
        }]
      };
    }
  );

  // 5. get_agencies - Verkehrsunternehmen
  server.tool(
    'get_agencies',
    'Gibt alle Verkehrsunternehmen (Transportunternehmen) zurück mit Anzahl ihrer Linien.',
    {},
    async () => {
      const d = getDb();
      const results = d.prepare(`
        SELECT a.agency_id, a.agency_name, a.agency_url,
               COUNT(r.route_id) as route_count
        FROM agency a
        LEFT JOIN routes r ON a.agency_id = r.agency_id
        GROUP BY a.agency_id
        ORDER BY route_count DESC
      `).all();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: results.length,
            agencies: results
          }, null, 2)
        }]
      };
    }
  );

  // 6. query_gtfs - Freie SQL-Abfrage (read-only, limitiert)
  server.tool(
    'query_gtfs',
    'Führt eine freie SQL-Abfrage auf den GTFS-Daten aus. Nur SELECT erlaubt. Tabellen: agency, stops, routes, trips, stop_times, calendar, calendar_dates, feed_info, transfers.',
    {
      sql: z.string().describe('SQL SELECT-Abfrage'),
      limit: z.number().int().min(1).max(1000).default(100).describe('Maximale Anzahl Ergebnisse')
    },
    async ({ sql, limit }) => {
      // Sicherheitsprüfung: Nur SELECT erlaubt
      const normalized = sql.trim().replace(/\s+/g, ' ').toUpperCase();
      const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX'];
      for (const keyword of forbidden) {
        // Prüfe ob das Keyword als eigenständiges Wort vorkommt (nicht als Teil eines Strings)
        const regex = new RegExp(`\\b${keyword}\\b`);
        if (regex.test(normalized)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Verbotene Operation: ${keyword}. Nur SELECT-Abfragen sind erlaubt.` }) }],
            isError: true
          };
        }
      }

      if (!normalized.startsWith('SELECT')) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Abfrage muss mit SELECT beginnen.' }) }],
          isError: true
        };
      }

      try {
        const d = getDb();
        // LIMIT erzwingen, falls nicht vorhanden
        let execSql = sql.trim();
        if (!normalized.includes('LIMIT')) {
          execSql += ` LIMIT ${limit}`;
        }

        const results = d.prepare(execSql).all();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: results.length,
              results
            }, null, 2)
          }]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `SQL-Fehler: ${err.message}` }) }],
          isError: true
        };
      }
    }
  );

  // === RESOURCES ===

  // gtfs://status - Aktueller Daten-Status
  server.resource(
    'gtfs-status',
    'gtfs://status',
    { description: 'Aktueller Status der GTFS-Daten (Download-Datum, Version, Tabellenstatistiken)' },
    async () => {
      const meta = getMeta();
      const stats = getDbStats();
      return {
        contents: [{
          uri: 'gtfs://status',
          mimeType: 'application/json',
          text: JSON.stringify({ meta, tables: stats }, null, 2)
        }]
      };
    }
  );

  // gtfs://schema - Datenbankschema
  server.resource(
    'gtfs-schema',
    'gtfs://schema',
    { description: 'Datenbankschema aller GTFS-Tabellen mit Spalten und Typen' },
    async () => {
      const d = getDb();
      const tables = d.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'"
      ).all();

      const schema = {};
      for (const { name } of tables) {
        const columns = d.prepare(`PRAGMA table_info(${name})`).all();
        schema[name] = columns.map(c => ({
          name: c.name,
          type: c.type,
          nullable: !c.notnull,
          primary_key: !!c.pk
        }));
      }

      return {
        contents: [{
          uri: 'gtfs://schema',
          mimeType: 'application/json',
          text: JSON.stringify(schema, null, 2)
        }]
      };
    }
  );

  return server;
}

// --- SQL-Validierung (shared) ---
function validateAndRunSQL(sql, limitDefault = 100) {
  const normalized = sql.trim().replace(/\s+/g, ' ').toUpperCase();
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX'];
  for (const keyword of forbidden) {
    if (new RegExp(`\\b${keyword}\\b`).test(normalized)) {
      return { error: `Verbotene Operation: ${keyword}. Nur SELECT-Abfragen sind erlaubt.` };
    }
  }
  if (!normalized.startsWith('SELECT')) {
    return { error: 'Abfrage muss mit SELECT beginnen.' };
  }

  const d = getDb();
  let execSql = sql.trim();
  if (!normalized.includes('LIMIT')) {
    execSql += ` LIMIT ${limitDefault}`;
  }

  const results = d.prepare(execSql).all();
  return { count: results.length, results };
}

// --- Express-App mit StreamableHTTP Transport ---
function createApp() {
  const app = express();

  // Statische Dateien (Frontend)
  app.use(express.static(path.join(__dirname, 'public')));

  // Health-Check Endpoint
  app.get('/health', (req, res) => {
    try {
      const meta = getMeta();
      const stats = getDbStats();
      res.json({
        status: 'ok',
        server: 'ZVV GTFS MCP Server',
        version: '2.0.0',
        database: {
          path: DB_PATH,
          exists: fs.existsSync(DB_PATH),
          ...meta,
          tables: stats
        },
        update: updateStatus
      });
    } catch (err) {
      res.status(503).json({
        status: 'error',
        error: err.message
      });
    }
  });

  // MCP StreamableHTTP Endpoint
  app.post('/mcp', async (req, res) => {
    try {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error('MCP-Fehler:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // GET /mcp und DELETE /mcp für Stateless-Modus ablehnen
  app.get('/mcp', (req, res) => {
    res.status(405).json({
      error: 'Method Not Allowed. Verwende POST für MCP-Anfragen.',
      hint: 'GET /health für Status-Informationen'
    });
  });

  app.delete('/mcp', (req, res) => {
    res.status(405).json({
      error: 'Method Not Allowed. Server läuft im Stateless-Modus.'
    });
  });

  // REST API für Frontend - SQL-Query Endpoint
  app.post('/api/query', express.json(), (req, res) => {
    try {
      const { sql, limit } = req.body || {};
      if (!sql) {
        return res.status(400).json({ error: 'SQL-Abfrage fehlt. Sende { "sql": "SELECT ..." }' });
      }
      const result = validateAndRunSQL(sql, limit || 200);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: `SQL-Fehler: ${err.message}` });
    }
  });

  // Root -> Frontend (wenn public/index.html existiert, wird express.static bedient)
  // Fallback JSON-API-Info, falls kein Frontend vorhanden
  app.get('/', (req, res, next) => {
    // express.static hat schon index.html serviert wenn vorhanden
    // Dieser Handler wird nur erreicht, wenn es kein index.html gibt
    res.json({
      name: 'ZVV GTFS MCP Server',
      version: '2.0.0',
      description: 'MCP Server für Schweizer ÖV-Fahrplandaten (GTFS)',
      endpoints: {
        mcp: 'POST /mcp',
        health: 'GET /health',
        query: 'POST /api/query',
        ui: 'GET /'
      }
    });
  });

  return app;
}

// --- GTFS Update-Status (wird beim Start gesetzt) ---
let updateStatus = { checked: false, updateAvailable: false, latest: null, checkedAt: null, error: null };

async function checkGtfsUpdateOnStartup() {
  try {
    const { checkForUpdate } = require('./check-update.js');
    const result = await checkForUpdate({ checkOnly: true });
    updateStatus = {
      checked: true,
      updateAvailable: result.updateAvailable || false,
      current: result.current || null,
      latest: result.latest || null,
      latestUrl: result.latestUrl || null,
      checkedAt: new Date().toISOString(),
      error: result.error || null
    };
    if (result.updateAvailable) {
      console.log(`\n  ⚠  Neues GTFS-Update verfuegbar: ${result.latest}`);
      console.log(`     Aktuell: ${result.current || '(keine)'}`);
      console.log(`     Update mit: node check-update.js\n`);
    }
  } catch (err) {
    updateStatus = { checked: true, updateAvailable: false, checkedAt: new Date().toISOString(), error: err.message };
    console.error(`[Update-Check] Fehler: ${err.message}`);
  }
}

// --- Server starten ---
if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`ZVV GTFS MCP Server gestartet`);
    console.log(`  MCP Endpoint:  http://localhost:${PORT}/mcp`);
    console.log(`  Health Check:  http://localhost:${PORT}/health`);
    console.log(`  Datenbank:     ${DB_PATH}`);

    // Async Update-Check im Hintergrund (blockiert Server-Start nicht)
    checkGtfsUpdateOnStartup();
  });
}

module.exports = { createMcpServer, createApp, getDb, getDbStats, getMeta, DB_PATH };
