const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// --- Konfiguration ---
const PORT = parseInt(process.env.PORT, 10) || 3000;
const DB_PATH = process.env.GTFS_DB_PATH || path.join(__dirname, 'zvv-data', 'gtfs.db');
// Ohne Token bleiben /mcp und /api/query offen. Das ist nur fuer rein
// lokalen Betrieb vertretbar -- sobald der Dienst ueber einen Tunnel
// erreichbar ist, muss MCP_AUTH_TOKEN gesetzt sein.
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';

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

/**
 * Gibt das DB-Handle frei. Noetig, bevor die Datei durch einen neuen
 * Fahrplan ersetzt wird -- sonst liest die offene Verbindung weiter den
 * alten Inode. Die naechste Abfrage oeffnet die Datei automatisch neu.
 */
function closeDb() {
  if (db) {
    try {
      db.close();
    } catch {
      // Handle war bereits zu -- nicht weiter tragisch
    }
    db = null;
  }
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

// --- Zeit-Hilfsfunktionen fuer GTFS ---
// GTFS-Zeiten koennen 24:00:00 ueberschreiten: ein Kurs, der um 00:30 des
// Folgetags faehrt, gehoert zum Service-Tag davor und ist als "24:30:00"
// kodiert. Ohne diese Behandlung fehlen alle Nachtkurse nach Mitternacht.

/** "HH:MM:SS" -> Sekunden seit Betriebstag-Beginn (HH darf > 23 sein) */
function hmsToSec(t) {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(t);
  if (!m) return NaN;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

/** Sekunden -> "HH:MM:SS" (immer zweistellige Stunde, kann > 23 sein) */
function secToHms(s) {
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

/** Verschiebt eine Startzeit um 24 h nach vorne, fuer die Vortags-Abfrage */
function shift24(t) {
  const s = hmsToSec(t);
  return Number.isNaN(s) ? t : secToHms(s + 24 * 3600);
}

/** Normalisiert eine >24h-Zeit auf die Wanduhr ("24:30:00" -> "00:30:00") */
function normalizeTime(t) {
  const s = hmsToSec(t);
  if (Number.isNaN(s)) return t;
  return secToHms(s % (24 * 3600));
}

/** Aktuelles Datum in der Zeitzone Europe/Zurich als YYYYMMDD */
function swissDateYmd(now) {
  // en-CA liefert YYYY-MM-DD; die Zeitzone bestimmt den Kalendertag.
  return (now || new Date()).toLocaleDateString('en-CA', { timeZone: 'Europe/Zurich' }).replace(/-/g, '');
}

/** YYYYMMDD -> YYYYMMDD des Vortags */
function prevYmd(ymd) {
  const dt = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Wochentag-Spalte (calendar) fuer ein YYYYMMDD */
function weekdayCol(ymd) {
  const cols = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dt = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  return cols[dt.getUTCDay()];
}

// Klassische GTFS-route_type-Werte (0-7) auf die erweiterten HVT-Bereiche
// abbilden, die der Schweizer Feed tatsaechlich verwendet. Ohne das liefert
// z.B. route_type=2 (Bahn) null Treffer, weil der Feed 100-199 nutzt.
const HVT_RANGES = {
  0: [900, 999],    // Tram
  1: [400, 499],    // Metro / Stadtbahn
  2: [100, 199],    // Bahn
  3: [700, 799],    // Bus
  4: [1000, 1099],  // Schiff / Faehre
  6: [1300, 1399],  // Luftseilbahn / Gondel
  7: [1400, 1499],  // Standseilbahn
};

// Aeltere Datenbanken kennen original_stop_id noch nicht.
let originalColCache;
function hasOriginalStopId(d) {
  if (originalColCache === undefined) {
    originalColCache = d.prepare('PRAGMA table_info(stops)').all().some(c => c.name === 'original_stop_id');
  }
  return originalColCache;
}

/**
 * Uebersetzt eine alte DIDOK-Nummer in die heutige SLOID.
 *
 * Schweizer DIDOK-Nummern sind 85 + fuenf Ziffern (8503000 = Zuerich HB).
 * Die SLOID nutzt denselben Kern ohne Laendervorsatz und ohne fuehrende
 * Nullen: ch:1:sloid:3000. Geprueft an Zuerich HB, Stadelhofen, Basel SBB,
 * Bern, Luzern, Lausanne und St. Gallen.
 *
 * Gibt null zurueck, wenn die Eingabe keine DIDOK-Nummer ist.
 */
function didokToSloid(stopId) {
  if (!/^85\d{5}$/.test(stopId)) return null;
  return 'ch:1:sloid:' + Number(stopId.slice(2));
}

/**
 * Findet alle Haltestellen-IDs, die zur uebergebenen gehoeren.
 *
 * Schweizer GTFS kennt mehrere Ebenen fuer denselben Ort: Station
 * (ch:1:sloid:3000), Elternstation (Parentch:1:sloid:3000) und einzelne
 * Gleise (ch:1:sloid:3000:3:4). Wer nach Abfahrten fragt, meint praktisch
 * immer alle davon.
 *
 * Seit Feed 2026-07 sind die alten DIDOK-Nummern durch SLOIDs ersetzt und
 * kommen im Feed gar nicht mehr vor. Ohne Uebersetzung liefert eine bekannte
 * Nummer wie 8503000 stillschweigend null Abfahrten -- schlimmer als ein
 * Fehler, weil es wie ein leerer Fahrplan aussieht statt wie eine falsche ID.
 *
 * Liefert { ids, matched }: matched=false heisst, die Eingabe passt auf keine
 * bekannte Haltestelle. Der Aufrufer soll das melden statt leer zu antworten.
 */
function resolveRelatedStops(d, stopId) {
  // Kandidaten: die Eingabe selbst, plus die uebersetzte SLOID.
  const candidates = [stopId];
  const sloid = didokToSloid(stopId);
  if (sloid) candidates.push(sloid);

  const placeholders = candidates.map(() => '?').join(',');
  // original_stop_id traegt bei auslaendischen Haltestellen die Alt-Kennung;
  // bei Schweizer Stops dupliziert sie nur die SLOID.
  const seeds = hasOriginalStopId(d)
    ? d.prepare(`SELECT stop_id, parent_station FROM stops WHERE stop_id IN (${placeholders}) OR original_stop_id IN (${placeholders})`).all(...candidates, ...candidates)
    : d.prepare(`SELECT stop_id, parent_station FROM stops WHERE stop_id IN (${placeholders})`).all(...candidates);

  // Eingabe immer mitfuehren, auch wenn sie in stops nicht auftaucht.
  const ids = new Set([stopId]);
  for (const s of seeds) ids.add(s.stop_id);

  const childStmt = d.prepare(`
    SELECT stop_id FROM stops
    WHERE parent_station = ?
       OR parent_station = ('Parent' || ?)
       OR stop_id LIKE (? || ':%')
  `);
  const siblingStmt = d.prepare('SELECT stop_id FROM stops WHERE parent_station = ?');

  for (const seed of seeds) {
    for (const r of childStmt.all(seed.stop_id, seed.stop_id, seed.stop_id)) ids.add(r.stop_id);
    if (seed.parent_station) {
      for (const r of siblingStmt.all(seed.parent_station)) ids.add(r.stop_id);
    }
  }

  return { ids: [...ids], matched: seeds.length > 0 };
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
    'Gibt ÖV-Linien zurück. Optional filterbar nach Agentur oder Linientyp. Für route_type sind sowohl die klassischen Werte (0=Tram, 1=Metro, 2=Bahn, 3=Bus, 4=Fähre, 6=Gondel, 7=Standseilbahn) als auch die erweiterten HVT-Werte des Schweizer Feeds (z.B. 700=Bus, 900=Tram, 100-199=Bahn) erlaubt; klassische Werte werden automatisch auf die HVT-Bereiche gemappt.',
    {
      agency_id: z.string().optional().describe('Filter nach Verkehrsunternehmen (agency_id)'),
      route_type: z.number().int().optional().describe('Filter nach Linientyp (klassisch 0-7 oder erweitert/HVT)'),
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
        // Klassischen Wert (0-7) auf den HVT-Bereich abbilden, sonst exakt.
        const range = HVT_RANGES[route_type];
        if (range) {
          sql += ' AND r.route_type BETWEEN ? AND ?';
          params.push(range[0], range[1]);
        } else {
          sql += ' AND r.route_type = ?';
          params.push(route_type);
        }
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

      // Zieldatum in Schweizer Zeit bestimmen -- nicht in UTC, sonst zeigt der
      // Server zwischen Mitternacht und ~02:00 den Fahrplan des Vortags.
      const targetDate = date || swissDateYmd();

      // Startzeit: explizite time_from gewinnt. Sonst: bei explizitem Datum ab
      // Tagesbeginn (der Nutzer will den ganzen Tag), bei "heute" ab jetzt.
      let startTime;
      if (time_from) {
        startTime = time_from;
      } else if (date) {
        startTime = '00:00:00';
      } else {
        startTime = new Date().toLocaleTimeString('de-CH', {
          timeZone: 'Europe/Zurich', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
      }

      const { ids: relatedStops, matched } = resolveRelatedStops(d, stop_id);

      // Eine unbekannte ID darf nicht wie ein leerer Fahrplan aussehen.
      if (!matched) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: `Haltestelle '${stop_id}' nicht gefunden.`,
              hint: 'Mit search_stops die aktuelle stop_id ermitteln. Seit Fahrplan 2026-07 nutzt die Schweiz SLOIDs (ch:1:sloid:3000) statt DIDOK-Nummern (8503000); alte Nummern werden automatisch uebersetzt, sofern sie gueltig sind.'
            }, null, 2)
          }],
          isError: true
        };
      }

      const stopPlaceholders = relatedStops.map(() => '?').join(',');

      // Eine Abfrage fuer einen Service-Tag. minTime ist eine GTFS-Zeit
      // (kann > 24:00 sein). Liefert Rohzeilen inkl. der GTFS-departure_time.
      const queryDay = (ymd, minTime) => d.prepare(`
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
            (
              t.service_id IN (
                SELECT service_id FROM calendar
                WHERE ${weekdayCol(ymd)} = 1 AND start_date <= ? AND end_date >= ?
              )
              AND t.service_id NOT IN (
                SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 2
              )
            )
            OR t.service_id IN (
              SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 1
            )
          )
        ORDER BY st.departure_time
        LIMIT ?
      `).all(...relatedStops, minTime, ymd, ymd, ymd, ymd, limit);

      // Heutiger Betriebstag ab startTime.
      const todayRows = queryDay(targetDate, startTime).map(r => ({
        ...r, _sort: hmsToSec(r.departure_time)
      }));

      // Nachtkurse aus dem VORTAGS-Service: ein Kurs um 00:30 heute ist dort
      // als 24:30 kodiert. Wir suchen Vortags-Zeiten >= startTime+24h und
      // normalisieren sie auf die Wanduhr.
      const prevDate = prevYmd(targetDate);
      const prevRows = queryDay(prevDate, shift24(startTime)).map(r => ({
        ...r,
        departure_time: normalizeTime(r.departure_time),
        arrival_time: r.arrival_time ? normalizeTime(r.arrival_time) : r.arrival_time,
        _sort: hmsToSec(r.departure_time) - 24 * 3600
      }));

      // Zusammenfuehren, nach Wanduhrzeit sortieren, auf limit kappen.
      const results = [...prevRows, ...todayRows]
        .sort((a, b) => a._sort - b._sort)
        .slice(0, limit)
        .map(({ _sort, ...rest }) => rest);

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
    'Führt eine freie SQL-Abfrage auf den GTFS-Daten aus. Nur SELECT erlaubt. Tabellen: agency, stops, routes, trips, stop_times, calendar, calendar_dates, feed_info, transfers, frequencies.',
    {
      sql: z.string().describe('SQL SELECT-Abfrage'),
      limit: z.number().int().min(1).max(1000).default(100).describe('Maximale Anzahl Ergebnisse')
    },
    async ({ sql, limit }) => {
      // Gemeinsame, gehaertete Validierung/Ausfuehrung (siehe validateAndRunSQL).
      const result = validateAndRunSQL(sql, limit);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!result.error
      };
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
  if (typeof sql !== 'string' || !sql.trim()) {
    return { error: 'SQL-Abfrage fehlt oder ist leer.' };
  }
  const trimmed = sql.trim();

  // Fuer die Schluesselwort-Pruefung String-Literale und "quoted identifiers"
  // ausblenden. Sonst loest ein Haltestellenname oder ein Literal wie 'CREATE'
  // faelschlich Alarm aus -- ein realer Falsch-Positiv des alten Codes.
  const scan = trimmed
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .toUpperCase();

  // Nur lesende Abfragen. WITH ... SELECT (CTE) ist erlaubt und rein lesend.
  if (!/^SELECT\b/.test(scan) && !/^WITH\b/.test(scan)) {
    return { error: 'Nur SELECT- oder WITH...SELECT-Abfragen sind erlaubt.' };
  }
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'REPLACE'];
  for (const keyword of forbidden) {
    if (new RegExp(`\\b${keyword}\\b`).test(scan)) {
      return { error: `Verbotene Operation: ${keyword}. Nur lesende Abfragen sind erlaubt.` };
    }
  }

  // limit robust auf eine positive Ganzzahl 1..1000 bringen -- der Wert darf
  // NIE roh aus dem Request in die SQL wandern (Injection/DoS via -1 oder riesig).
  const cap = Math.max(1, Math.min(1000, Math.floor(Number(limitDefault)) || 100));

  // Nur anhaengen, wenn keine ECHTE abschliessende LIMIT-Klausel existiert
  // (Substring in einem Alias wie "deLIMITer" darf die Kappung nicht umgehen).
  const hasLimit = /\bLIMIT\s+\d+/.test(scan);
  const execSql = hasLimit ? trimmed : `${trimmed} LIMIT ${cap}`;

  try {
    const d = getDb();
    const results = d.prepare(execSql).all();
    return { count: results.length, results };
  } catch (err) {
    return { error: `SQL-Fehler: ${err.message}` };
  }
}

// --- Zugriffsschutz ---

/** Vergleicht zwei Strings in konstanter Zeit */
function safeEqual(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Verlangt "Authorization: Bearer <MCP_AUTH_TOKEN>", sofern ein Token konfiguriert ist */
function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();

  const header = req.get('authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (provided && safeEqual(provided, AUTH_TOKEN)) return next();

  res.set('WWW-Authenticate', 'Bearer');
  res.status(401).json({
    error: 'Nicht autorisiert.',
    hint: 'Header "Authorization: Bearer <MCP_AUTH_TOKEN>" erforderlich.'
  });
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
          // Absoluter Pfad bewusst nicht im Response -- /health ist auch
          // dann offen, wenn der Rest per Token geschuetzt ist.
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
  app.post('/mcp', requireAuth, async (req, res) => {
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
  app.post('/api/query', requireAuth, express.json(), (req, res) => {
    try {
      const { sql, limit } = req.body || {};
      if (!sql) {
        return res.status(400).json({ error: 'SQL-Abfrage fehlt. Sende { "sql": "SELECT ..." }' });
      }
      const result = validateAndRunSQL(sql, limit || 200);
      res.status(result.error ? 400 : 200).json(result);
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

// --- GTFS Auto-Update ---
// Der Fahrplan wird mehrmals im Jahr neu veroeffentlicht. Ein Container,
// der monatelang laeuft, wuerde ohne das hier auf altem Stand haengenbleiben.
const AUTO_UPDATE = (process.env.GTFS_AUTO_UPDATE || 'true').toLowerCase() !== 'false';
const UPDATE_INTERVAL_HOURS = Number(process.env.GTFS_UPDATE_INTERVAL_HOURS) || 24;

let updateStatus = {
  checked: false, updateAvailable: false, updating: false,
  current: null, latest: null, lastUpdatedAt: null, checkedAt: null, error: null
};
let updateRunning = false;

async function runUpdateCycle() {
  if (updateRunning) return;
  updateRunning = true;
  updateStatus.updating = true;

  try {
    const { checkForUpdate } = require('./check-update.js');
    const result = await checkForUpdate({
      // Ohne Auto-Update nur melden, nicht anfassen.
      checkOnly: !AUTO_UPDATE,
      // Handle schliessen, bevor die DB-Datei ersetzt wird.
      onBeforeSwap: closeDb
    });

    updateStatus = {
      checked: true,
      updateAvailable: result.updateAvailable || false,
      updating: false,
      current: result.current || updateStatus.current,
      latest: result.latest || null,
      lastUpdatedAt: result.updated ? new Date().toISOString() : updateStatus.lastUpdatedAt,
      checkedAt: new Date().toISOString(),
      error: result.error || null
    };

    if (result.updated) {
      console.log(`[Update] Neuer Fahrplan aktiv: ${result.latest}`);
    } else if (result.updateAvailable && !AUTO_UPDATE) {
      console.log(`[Update] Neuer Fahrplan verfuegbar: ${result.latest} (Auto-Update ist aus)`);
    }
  } catch (err) {
    updateStatus = { ...updateStatus, checked: true, updating: false, checkedAt: new Date().toISOString(), error: err.message };
    console.error(`[Update] Fehler: ${err.message}`);
  } finally {
    updateRunning = false;
    updateStatus.updating = false;
  }
}

function startUpdateScheduler() {
  // Erster Lauf sofort, aber im Hintergrund -- der Server nimmt waehrenddessen
  // schon Anfragen an und liefert den bisherigen Bestand aus.
  runUpdateCycle();

  if (AUTO_UPDATE) {
    const timer = setInterval(runUpdateCycle, UPDATE_INTERVAL_HOURS * 3600 * 1000);
    // Soll den Prozess nicht am Leben halten.
    timer.unref();
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

    if (AUTH_TOKEN) {
      console.log(`  Zugriff:       Token-geschuetzt (MCP_AUTH_TOKEN)`);
    } else {
      console.log(`\n  ⚠  MCP_AUTH_TOKEN ist nicht gesetzt.`);
      console.log(`     /mcp und /api/query sind ohne Authentifizierung erreichbar.`);
      console.log(`     Fuer oeffentliche Erreichbarkeit (z.B. Cloudflare-Tunnel) zwingend setzen.\n`);
    }

    if (AUTO_UPDATE) {
      console.log(`  Auto-Update:   alle ${UPDATE_INTERVAL_HOURS} h`);
    } else {
      console.log(`  Auto-Update:   aus (nur Meldung)`);
    }

    // Laeuft im Hintergrund, blockiert weder Start noch laufende Anfragen.
    startUpdateScheduler();
  });
}

module.exports = {
  createMcpServer, createApp, getDb, closeDb, getDbStats, getMeta, runUpdateCycle, DB_PATH,
  // Reine Hilfsfunktionen fuer Unit-Tests:
  validateAndRunSQL, safeEqual, didokToSloid,
  hmsToSec, secToHms, shift24, normalizeTime, swissDateYmd, prevYmd, weekdayCol, HVT_RANGES
};
