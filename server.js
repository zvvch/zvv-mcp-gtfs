const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { registerTools } = require('./mcp-tools.js');
const oauth = require('./oauth.js');
// Eine Quelle fuer die Version -- vorher standen 2.0.0 und 3.0.0 nebeneinander.
const VERSION = require('./package.json').version;

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
    // Alles, was an die alte Datei gebunden war, verwerfen.
    statsCache = null;
    normColCache = undefined;
    originalColCache = undefined;
  }
}

// --- Hilfsfunktionen ---

// Die Datenbank ist readonly; die Zeilenzahlen aendern sich nur beim
// Update-Schwenk (der closeDb aufruft). Ohne Cache wuerde jeder /health-
// Aufruf -- inkl. des Docker-Healthchecks alle 30 s -- volle COUNT(*)-Scans
// ueber 40 Mio. Zeilen ausloesen. Ein unauth. Poller waere ein DoS-Verstaerker.
let statsCache = null;

/** Gibt DB-Statistiken zurück (gecacht bis zum naechsten DB-Schwenk) */
function getDbStats() {
  if (statsCache) return statsCache;
  const d = getDb();
  const tables = d.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'"
  ).all();

  const stats = {};
  for (const { name } of tables) {
    const row = d.prepare(`SELECT COUNT(*) as count FROM "${name}"`).get();
    stats[name] = row.count;
  }
  statsCache = stats;
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

// Muss identisch zu NORMALIZE_SQL im Importer arbeiten, sonst findet die
// Suche nichts: der Suchbegriff wird hier genauso zugerichtet wie die Spalte.
const { NORMALIZE_SQL } = require('./import-gtfs.js');
function normalizeForSearch(s) {
  return String(s).toLowerCase()
    .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ä/g, 'a')
    .replace(/é/g, 'e').replace(/è/g, 'e').replace(/à/g, 'a').replace(/ç/g, 'c');
}

// Aeltere Datenbanken kennen stop_name_norm noch nicht.
let normColCache;
function hasStopNameNorm(d) {
  if (normColCache === undefined) {
    normColCache = d.prepare('PRAGMA table_info(stops)').all().some(c => c.name === 'stop_name_norm');
  }
  return normColCache;
}

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
/**
 * Baut einen MCP-Server. Mit admin:true kommt zusaetzlich die freie
 * SQL-Abfrage dazu -- die gehoert nur hinter den geschuetzten Endpunkt.
 */
function createMcpServer(options = {}) {
  const server = new McpServer({
    name: options.admin ? 'ZVV GTFS MCP Server (admin)' : 'ZVV GTFS MCP Server',
    version: VERSION
  });

  // Die Tools liegen in mcp-tools.js. Die Abhaengigkeiten werden
  // hineingereicht, damit kein Zirkelbezug entsteht.
  registerTools(server, {
    getDb, resolveRelatedStops, getMeta, getDbStats, validateAndRunSQL,
    normalizeForSearch, hasStopNameNorm, NORMALIZE_SQL, HVT_RANGES,
    swissDateYmd, weekdayCol, prevYmd, shift24, normalizeTime, hmsToSec,
  }, { admin: !!options.admin });

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

  // Fuer die Pruefung eine bereinigte Fassung bilden:
  //  1. String-Literale und "quoted identifiers" ausblenden -- sonst loest ein
  //     Haltestellenname oder ein Literal wie 'CREATE' faelschlich Alarm aus.
  //  2. Kommentare entfernen -- eine Abfrage darf mit "-- Erklaerung" beginnen,
  //     ohne dass die SELECT-Pruefung daran scheitert. Reihenfolge zaehlt:
  //     erst Literale, damit ein "--" INNERHALB eines Strings kein Kommentar ist.
  const scan = trimmed
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
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

// --- Brute-Force-Schutz ---
// Ein kurzer PIN ist bequem, aber durchprobierbar. Nach MAX_FAILS
// Fehlversuchen wird die Quell-IP fuer LOCK_MS gesperrt. Damit sind auch
// achtstellige PINs praktisch nicht mehr zu erraten: 10 Versuche pro
// 15 Minuten bedeuten fuer 10^8 Moeglichkeiten Jahrtausende.
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;
const MAX_TRACKED_IPS = 10000;
const authFailures = new Map();

// Zusaetzlich eine GLOBALE Bremse. Die IP-Sperre allein laesst sich durch
// Rotieren der Quell-IP umgehen -- bei einem kurzen PIN waere der Raum damit
// in Stunden durchprobiert. Diese Schranke gilt unabhaengig von der Herkunft.
const GLOBAL_MAX_FAILS = 30;
const GLOBAL_WINDOW_MS = 15 * 60 * 1000;
let globalFails = 0;
let globalWindowStart = 0;

/** true, wenn insgesamt zu viele Fehlversuche im laufenden Fenster liegen */
function globallyThrottled(now) {
  if (now - globalWindowStart > GLOBAL_WINDOW_MS) {
    globalWindowStart = now;
    globalFails = 0;
    return false;
  }
  return globalFails >= GLOBAL_MAX_FAILS;
}

function noteGlobalFail(now) {
  if (now - globalWindowStart > GLOBAL_WINDOW_MS) {
    globalWindowStart = now;
    globalFails = 0;
  }
  globalFails += 1;
  if (globalFails === GLOBAL_MAX_FAILS) {
    console.warn(`[Auth] Globale Bremse aktiv: ${GLOBAL_MAX_FAILS} Fehlversuche in ${GLOBAL_WINDOW_MS / 60000} min.`);
  }
}

/** Echte Client-IP -- hinter dem Cloudflare-Tunnel steht sie im Header */
function clientIp(req) {
  return req.get('cf-connecting-ip') || req.ip || 'unknown';
}

// --- Browser-Session ---
// Damit der PIN nur EINMAL eingegeben werden muss, stellt der Server nach
// erfolgreicher Anmeldung ein signiertes HttpOnly-Cookie aus. Es ist
// zustandslos: der Ablaufzeitpunkt steckt drin und ist per HMAC signiert,
// es braucht also keinen Session-Speicher. MCP-Clients nutzen weiterhin
// den Bearer-Header und sind davon unberuehrt.
const SESSION_COOKIE = 'gtfs_session';
const SESSION_MAX_AGE_S = 30 * 24 * 3600;

function signSession(expMs) {
  const payload = String(expMs);
  const sig = crypto.createHmac('sha256', AUTH_TOKEN).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySession(value) {
  if (!value) return false;
  const i = value.lastIndexOf('.');
  if (i < 1) return false;
  const payload = value.slice(0, i);
  const sig = value.slice(i + 1);
  const expected = crypto.createHmac('sha256', AUTH_TOKEN).update(payload).digest('hex');
  if (!safeEqual(sig, expected)) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > Date.now();
}

/** Liest ein einzelnes Cookie aus dem Request (ohne Zusatzabhaengigkeit) */
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/**
 * Bucht einen Fehlversuch fuer eine IP und sperrt sie ggf.
 * Zentral, damit alle Anmeldewege (Header, /api/login, /authorize) in
 * denselben Zaehler laufen -- sonst waere jeder neue Weg ein Schlupfloch.
 */
function noteAuthFailure(ip, now) {
  const rec = authFailures.get(ip);
  const expired = rec && rec.until > 0 && rec.until <= now;
  const cur = (!rec || expired) ? { count: 0, until: 0 } : rec;
  cur.count += 1;
  if (cur.count >= MAX_FAILS) {
    cur.until = now + LOCK_MS;
    cur.count = 0;
    console.warn(`[Auth] IP ${ip} nach ${MAX_FAILS} Fehlversuchen fuer ${LOCK_MS / 60000} min gesperrt.`);
  }
  authFailures.set(ip, cur);
  pruneAuthFailures(now);
  noteGlobalFail(now);
}

/** Haelt die Map klein, falls sie durch verteilte Versuche volllaeuft */
function pruneAuthFailures(now) {
  if (authFailures.size < MAX_TRACKED_IPS) return;
  for (const [ip, rec] of authFailures) {
    if (rec.until <= now) authFailures.delete(ip);
  }
}

/** Verlangt "Authorization: Bearer <MCP_AUTH_TOKEN>", sofern ein Token konfiguriert ist */
function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();

  const ip = clientIp(req);
  const now = Date.now();
  const rec = authFailures.get(ip);

  if (rec && rec.until > now) {
    const wait = Math.ceil((rec.until - now) / 1000);
    res.set('Retry-After', String(wait));
    return res.status(429).json({
      error: 'Zu viele Fehlversuche. Bitte spaeter erneut versuchen.',
      retry_after_seconds: wait
    });
  }

  // Globale Bremse -- greift auch, wenn die Versuche ueber viele IPs streuen.
  // Eine gueltige Session/ein gueltiger Token kommt weiter unten trotzdem durch.
  const throttled = globallyThrottled(now);

  // Gueltige Browser-Session? Dann kein PIN noetig.
  if (verifySession(readCookie(req, SESSION_COOKIE))) {
    authFailures.delete(ip);
    return next();
  }

  const header = req.get('authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  // Der PIN direkt als Bearer -- bequem fuer CLI-Clients.
  if (provided && safeEqual(provided, AUTH_TOKEN)) {
    authFailures.delete(ip); // sauberer Zugriff setzt den Zaehler zurueck
    return next();
  }

  // Oder ein per OAuth ausgestelltes Access-Token. Die Typtrennung in
  // oauth.verify stellt sicher, dass hier kein Session-Cookie oder
  // Refresh-Token durchrutscht, obwohl alle dasselbe Secret nutzen.
  const at = provided ? oauth.verify(AUTH_TOKEN, 't', provided) : null;
  if (at) {
    // Audience-Pruefung (RFC 8707): ein Token, das fuer eine ANDERE
    // Ressource ausgestellt wurde, darf hier nicht gelten. Fehlt die
    // Angabe, weil der Client keinen resource-Parameter geschickt hat,
    // lassen wir es zu -- das Token kann ohnehin nur von diesem Server
    // stammen, weil nur er das Signaturgeheimnis kennt.
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    const self = `${proto}://${req.get('host')}/mcp-admin`;
    if (at.res && at.res !== self) {
      res.set('WWW-Authenticate',
        `Bearer error="invalid_token", error_description="Token wurde fuer eine andere Ressource ausgestellt"`);
      return res.status(401).json({ error: 'invalid_token', error_description: `Token gilt fuer ${at.res}, nicht fuer ${self}.` });
    }
    authFailures.delete(ip);
    return next();
  }

  // Fehlversuch buchen. Nur nach einer ABGELAUFENEN Sperre (until > 0) faengt
  // der Zaehler neu an -- until === 0 heisst "noch nie gesperrt" und darf den
  // laufenden Zaehler nicht zuruecksetzen.
  const expired = rec && rec.until > 0 && rec.until <= now;
  const cur = (!rec || expired) ? { count: 0, until: 0 } : rec;
  cur.count += 1;
  if (cur.count >= MAX_FAILS) {
    cur.until = now + LOCK_MS;
    cur.count = 0;
    console.warn(`[Auth] IP ${ip} nach ${MAX_FAILS} Fehlversuchen fuer ${LOCK_MS / 60000} min gesperrt.`);
  }
  authFailures.set(ip, cur);
  pruneAuthFailures(now);
  noteGlobalFail(now);

  if (throttled) {
    res.set('Retry-After', '900');
    return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte spaeter erneut versuchen.' });
  }

  // Der Verweis auf die Ressourcen-Metadaten ist der Einstieg in den
  // OAuth-Fluss: daran erkennt ein Client, wo er sich anmelden kann.
  //
  // Der Pfad MUSS zum resource-Wert im Dokument passen. RFC 9728 §3 schiebt
  // den well-known-String ZWISCHEN Host und Pfad, und §3.3 verlangt, dass
  // das gelieferte "resource" exakt der Kennung entspricht, aus der die
  // Abruf-URL gebildet wurde. Ein Verweis auf die Wurzel bei
  // resource=<base>/mcp-admin muss ein streng pruefender Client zurueckweisen.
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const meta = `${proto}://${req.get('host')}/.well-known/oauth-protected-resource/mcp-admin`;
  res.set('WWW-Authenticate',
    `Bearer realm="mcp", resource_metadata="${meta}", scope="gtfs:read gtfs:query"`);
  res.status(401).json({
    error: 'Nicht autorisiert.',
    hint: 'Entweder "Authorization: Bearer <PIN>" oder ein per OAuth ausgestelltes Access-Token.'
  });
}

// --- OAuth 2.1 mit PKCE fuer /mcp-admin ---
//
// Der Server ist zugleich Resource Server und Authorization Server. Das ist
// fuer ein Einzelnutzer-Setup angemessen und haelt den Betrieb einfach:
// alle Artefakte sind HMAC-signiert und zustandslos (siehe oauth.js).
//
// Der oeffentliche /mcp bleibt davon voellig unberuehrt und anonym.

const usedCodes = oauth.createUsedCodeStore();

/** Basis-URL, wie der Client sie sieht (hinter dem Tunnel via Forwarded-Header) */
function baseUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

/** Metadaten der geschuetzten Ressource (RFC 9728) */
function protectedResourceMetadata(req) {
  const base = baseUrl(req);
  return {
    resource: `${base}/mcp-admin`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['gtfs:read', 'gtfs:query'],
    resource_documentation: `${base}/`,
  };
}

/** Metadaten des Authorization Servers (RFC 8414) */
function authServerMetadata(req) {
  const base = baseUrl(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: ['gtfs:read', 'gtfs:query'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // PKCE ist in OAuth 2.1 Pflicht; wir verlangen S256.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

/** Seite zur PIN-Eingabe im Autorisierungsschritt */
function authorizePage(params, fehler) {
  const hidden = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`)
    .join('\n      ');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZVV GTFS – Zugriff erlauben</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0d0f14;color:#e7eaf0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
  .box{background:#14161c;border:1px solid #2a2f3a;border-radius:12px;padding:30px;width:min(430px,92vw)}
  h1{font-size:18px;margin:0 0 6px}
  p{color:#8b93a5;font-size:13px;margin:0 0 18px}
  .app{color:#6ea8fe;font-weight:600}
  input[type=password]{width:100%;box-sizing:border-box;padding:12px 14px;font-size:20px;
       letter-spacing:.22em;text-align:center;border-radius:8px;border:1px solid #2a2f3a;
       background:#0d0f14;color:#e7eaf0;outline:none}
  input[type=password]:focus{border-color:#6ea8fe}
  button{width:100%;margin-top:16px;padding:11px;border-radius:8px;border:0;
       background:#6ea8fe;color:#0b0d12;font-size:15px;font-weight:600;cursor:pointer}
  .err{background:#3b1219;border:1px solid #7f1d2e;color:#fda4af;padding:9px 12px;
       border-radius:8px;font-size:13px;margin-bottom:14px}
  .scope{background:#0d0f14;border:1px solid #2a2f3a;border-radius:8px;padding:10px 12px;
       font-size:12px;color:#8b93a5;margin-bottom:16px}
</style></head><body>
  <form class="box" method="POST" action="/authorize">
    <h1>Zugriff erlauben</h1>
    <p><span class="app">${String(params.client_name || 'Eine Anwendung')}</span> möchte auf die ZVV-GTFS-Fahrplandaten zugreifen.</p>
    ${fehler ? `<div class="err">${fehler}</div>` : ''}
    <div class="scope">Erlaubt werden: Fahrplanabfragen und freie SQL-Abfragen (nur lesend).</div>
    ${hidden}
    <input type="password" name="pin" inputmode="numeric" placeholder="PIN" autofocus aria-label="PIN">
    <button type="submit">Zugriff erlauben</button>
  </form>
</body></html>`;
}

function mountOAuth(app) {
  const form = express.urlencoded({ extended: false });

  // --- Discovery ---
  // Beide Pfadvarianten bedienen: RFC 9728 haengt den Ressourcenpfad an,
  // manche Clients fragen aber die blanke Wurzel ab.
  const prm = (req, res) => res.json(protectedResourceMetadata(req));
  app.get('/.well-known/oauth-protected-resource', prm);
  app.get('/.well-known/oauth-protected-resource/mcp-admin', prm);
  app.get('/.well-known/oauth-protected-resource/mcp', prm);

  const asm = (req, res) => res.json(authServerMetadata(req));
  app.get('/.well-known/oauth-authorization-server', asm);
  app.get('/.well-known/oauth-authorization-server/mcp-admin', asm);

  // --- Dynamic Client Registration (RFC 7591) ---
  // Zustandslos: die client_id IST die signierte Registrierung. Damit
  // ueberlebt sie Neustarts, ohne dass etwas gespeichert werden muss.
  app.post('/register', express.json(), (req, res) => {
    const body = req.body || {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!redirectUris.length) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris fehlt.' });
    }
    for (const u of redirectUris) {
      // Nur absolute http(s)- oder benutzerdefinierte Schemata (Desktop-Clients).
      if (typeof u !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(u)) {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: `Ungueltige redirect_uri: ${u}` });
      }
    }
    const client_id = oauth.sign(AUTH_TOKEN || 'unset', 'c', {
      u: redirectUris,
      n: String(body.client_name || 'MCP Client').slice(0, 80),
      exp: Date.now() + oauth.CLIENT_TTL_S * 1000,
    });
    res.status(201).json({
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: body.client_name || 'MCP Client',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  /** Gemeinsame Pruefung der Autorisierungsanfrage */
  function checkAuthorizeRequest(q) {
    const client = oauth.verify(AUTH_TOKEN || 'unset', 'c', q.client_id);
    if (!client) return { err: 'invalid_client', desc: 'client_id unbekannt oder abgelaufen.' };
    if (q.response_type !== 'code') return { err: 'unsupported_response_type', desc: 'Nur response_type=code.' };
    if (!q.redirect_uri || !client.u.includes(q.redirect_uri)) {
      // Bewusst KEIN Redirect: eine nicht registrierte Adresse darf nicht
      // angesteuert werden, sonst waere das ein offener Redirect.
      return { err: 'invalid_redirect_uri', desc: 'redirect_uri ist fuer diesen Client nicht registriert.' };
    }
    if (!q.code_challenge) return { err: 'invalid_request', desc: 'code_challenge fehlt (PKCE ist Pflicht).' };
    if ((q.code_challenge_method || 'plain') !== 'S256') {
      return { err: 'invalid_request', desc: 'Nur code_challenge_method=S256.' };
    }
    return { client };
  }

  // --- Autorisierung: Formular anzeigen ---
  app.get('/authorize', (req, res) => {
    const q = req.query;
    const chk = checkAuthorizeRequest(q);
    if (chk.err) return res.status(400).json({ error: chk.err, error_description: chk.desc });
    res.type('html').send(authorizePage({
      client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state,
      code_challenge: q.code_challenge, code_challenge_method: q.code_challenge_method,
      scope: q.scope, resource: q.resource, client_name: chk.client.n,
    }, null));
  });

  // --- Autorisierung: PIN pruefen und Code ausstellen ---
  app.post('/authorize', form, (req, res) => {
    const q = req.body || {};
    const chk = checkAuthorizeRequest(q);
    if (chk.err) return res.status(400).json({ error: chk.err, error_description: chk.desc });

    const ip = clientIp(req);
    const now = Date.now();
    const rec = authFailures.get(ip);
    if ((rec && rec.until > now) || globallyThrottled(now)) {
      return res.status(429).type('html').send(authorizePage(
        { ...q, client_name: chk.client.n },
        'Zu viele Fehlversuche. Bitte spaeter erneut versuchen.'
      ));
    }

    if (!AUTH_TOKEN || !oauth.safeEqual(String(q.pin || ''), AUTH_TOKEN)) {
      // Fehlversuche laufen in dieselbe Sperre wie ueberall sonst.
      noteAuthFailure(ip, now);
      return res.status(401).type('html').send(authorizePage(
        { ...q, client_name: chk.client.n }, 'Falscher PIN.'
      ));
    }
    authFailures.delete(ip);

    const code = oauth.sign(AUTH_TOKEN, 'a', {
      r: q.redirect_uri,
      cc: q.code_challenge,
      res: q.resource || null,
      sc: q.scope || 'gtfs:read gtfs:query',
      j: crypto.randomBytes(9).toString('base64url'),   // fuer die Einmalverwendung
      exp: now + oauth.CODE_TTL_MS,
    });

    const to = new URL(q.redirect_uri);
    to.searchParams.set('code', code);
    if (q.state) to.searchParams.set('state', q.state);
    res.redirect(302, to.toString());
  });

  // --- Token-Ausgabe ---
  app.post('/token', form, express.json(), (req, res) => {
    const b = req.body || {};
    const issue = (scope, resource) => {
      const exp = Date.now() + oauth.ACCESS_TTL_S * 1000;
      return {
        access_token: oauth.sign(AUTH_TOKEN, 't', { sc: scope, res: resource || null, exp }),
        token_type: 'Bearer',
        expires_in: oauth.ACCESS_TTL_S,
        scope,
        refresh_token: oauth.sign(AUTH_TOKEN, 'r', {
          sc: scope, res: resource || null, exp: Date.now() + oauth.REFRESH_TTL_S * 1000,
        }),
      };
    };

    if (b.grant_type === 'authorization_code') {
      const code = oauth.verify(AUTH_TOKEN || 'unset', 'a', b.code);
      if (!code) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code ungueltig oder abgelaufen.' });
      if (code.r !== b.redirect_uri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri stimmt nicht mit der Autorisierung ueberein.' });
      }
      if (!oauth.pkceMatches(b.code_verifier, code.cc, 'S256')) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE-Pruefung fehlgeschlagen.' });
      }
      // Ein Code gilt genau einmal.
      if (usedCodes.seen(code.j, code.exp)) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Code wurde bereits eingeloest.' });
      }
      return res.json(issue(code.sc, code.res));
    }

    if (b.grant_type === 'refresh_token') {
      const rt = oauth.verify(AUTH_TOKEN || 'unset', 'r', b.refresh_token);
      if (!rt) return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh-Token ungueltig oder abgelaufen.' });
      return res.json(issue(rt.sc, rt.res));
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
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
        version: VERSION,
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
  /** Baut einen MCP-Request-Handler fuer die gewuenschte Tool-Auswahl */
  function mcpHandler(admin) {
    return async (req, res) => {
      try {
        const server = createMcpServer({ admin });
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
    };
  }

  // Oeffentlicher MCP-Endpunkt: OHNE Anmeldung, nur lesende Fachabfragen.
  // Die Fahrplandaten sind offene Daten; schuetzenswert ist nicht ihre
  // Vertraulichkeit, sondern die Rechenlast. Die liegt bei der freien
  // SQL-Abfrage -- und die gibt es hier bewusst nicht.
  app.post('/mcp', mcpHandler(false));

  // Geschuetzter Endpunkt: zusaetzlich query_gtfs, nur mit Token/Sitzung.
  app.post('/mcp-admin', requireAuth, mcpHandler(true));

  app.get('/mcp-admin', (req, res) => {
    res.status(405).json({ error: 'Method Not Allowed. Verwende POST.' });
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

  mountOAuth(app);

  // Anmeldung fuer das Frontend: PIN gegen ein langlebiges Session-Cookie
  // tauschen, damit er nicht bei jedem Aufruf neu eingegeben werden muss.
  app.post('/api/login', express.json(), (req, res) => {
    if (!AUTH_TOKEN) {
      return res.json({ ok: true, note: 'Server laeuft ohne PIN-Schutz.' });
    }

    const ip = clientIp(req);
    const now = Date.now();
    const rec = authFailures.get(ip);
    if (rec && rec.until > now) {
      const wait = Math.ceil((rec.until - now) / 1000);
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: 'Zu viele Fehlversuche.', retry_after_seconds: wait });
    }

    if (globallyThrottled(now)) {
      res.set('Retry-After', '900');
      return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte spaeter erneut versuchen.' });
    }

    const pin = (req.body && req.body.pin) ? String(req.body.pin) : '';
    if (!pin || !safeEqual(pin, AUTH_TOKEN)) {
      noteGlobalFail(now);
      // Fehlversuche zaehlen wie bei requireAuth -- sonst waere /api/login
      // ein Schlupfloch am Brute-Force-Schutz vorbei.
      const expired = rec && rec.until > 0 && rec.until <= now;
      const cur = (!rec || expired) ? { count: 0, until: 0 } : rec;
      cur.count += 1;
      if (cur.count >= MAX_FAILS) {
        cur.until = now + LOCK_MS;
        cur.count = 0;
        console.warn(`[Auth] IP ${ip} nach ${MAX_FAILS} Fehlversuchen fuer ${LOCK_MS / 60000} min gesperrt.`);
      }
      authFailures.set(ip, cur);
      pruneAuthFailures(now);
      return res.status(401).json({ error: 'Falscher PIN.' });
    }

    authFailures.delete(ip);
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(signSession(now + SESSION_MAX_AGE_S * 1000))}`,
      'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${SESSION_MAX_AGE_S}`
    ];
    if (secure) parts.push('Secure');
    res.set('Set-Cookie', parts.join('; '));
    res.json({ ok: true, valid_days: SESSION_MAX_AGE_S / 86400 });
  });

  // Anmeldestatus fuer das Frontend: erlaubt es, die Oberflaeche schon beim
  // Laden zu sperren, statt erst beim ersten fehlgeschlagenen Aufruf.
  app.get('/api/session', (req, res) => {
    res.json({
      protected: !!AUTH_TOKEN,
      authenticated: !AUTH_TOKEN || verifySession(readCookie(req, SESSION_COOKIE))
    });
  });

  /** Abmelden: Session-Cookie loeschen */
  app.post('/api/logout', (req, res) => {
    res.set('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  // Autocomplete fuer die Haltestellensuche.
  // Eigener schlanker Endpunkt statt /api/query: pro Tastendruck soll kein
  // SQL ueber die Leitung gehen, und das Ergebnis wird nach Namen
  // zusammengefasst -- "Zuerich HB" existiert 27 Mal (je Gleis) und gehoert
  // trotzdem nur einmal in die Vorschlagsliste.
  app.get('/api/suggest', requireAuth, (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ count: 0, suggestions: [] });

      const limit = Math.max(1, Math.min(50, Math.floor(Number(req.query.limit)) || 20));
      const d = getDb();

      // stop_name_norm ist kleingeschrieben und ohne Diakritika -- damit
      // findet "zurich" auch "Zürich". Aeltere Datenbanken haben die Spalte
      // noch nicht; dann wird zur Laufzeit normalisiert (langsamer, aber
      // funktionsgleich).
      const hasNorm = hasStopNameNorm(d);
      const col = hasNorm ? 'stop_name_norm' : NORMALIZE_SQL('stop_name');

      const stmt = d.prepare(`
        SELECT stop_name,
               MIN(stop_id)      AS stop_id,
               COUNT(*)          AS variants,
               MIN(stop_lat)     AS stop_lat,
               MIN(stop_lon)     AS stop_lon,
               MAX(location_type) AS location_type
        FROM stops
        WHERE ${col} LIKE ?
        GROUP BY stop_name
        ORDER BY
          CASE WHEN ${col} LIKE ? THEN 0 ELSE 1 END,  -- Treffer am Wortanfang zuerst
          LENGTH(stop_name),                          -- kurze Namen = meist die Hauptstation
          stop_name
        LIMIT ?
      `);

      const needle = normalizeForSearch(q);
      let rows = stmt.all(`%${needle}%`, `${needle}%`, limit);

      // Rueckfall fuer die deutsche Umschreibung: wer "zuerich" tippt, meint
      // "Zürich". Erst als zweiter Versuch, damit echte "ue"-Namen wie
      // "Neuenburg" bei der normalen Suche nicht verstuemmelt werden.
      if (!rows.length) {
        const collapsed = needle.replace(/ue/g, 'u').replace(/oe/g, 'o').replace(/ae/g, 'a');
        if (collapsed !== needle) {
          rows = stmt.all(`%${collapsed}%`, `${collapsed}%`, limit);
        }
      }

      res.json({ count: rows.length, suggestions: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
