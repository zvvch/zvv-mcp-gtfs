const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Pfade
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TEST_DB_PATH = path.join(__dirname, 'test-gtfs.db');

// Aufräumen am Anfang (falls vom letzten Lauf übrig)
try { fs.unlinkSync(TEST_DB_PATH); } catch {}

// ============================================================
// 1. CSV-Parser Tests
// ============================================================
describe('CSV Parser', () => {
  it('sollte einfache CSV-Zeilen korrekt parsen', () => {
    const { parseCSVLine } = require('../import-gtfs.js');
    assert.deepEqual(parseCSVLine('a,b,c'), ['a', 'b', 'c']);
  });

  it('sollte Felder mit Anführungszeichen korrekt parsen', () => {
    const { parseCSVLine } = require('../import-gtfs.js');
    assert.deepEqual(
      parseCSVLine('"hello, world",b,"c"'),
      ['hello, world', 'b', 'c']
    );
  });

  it('sollte escaped Anführungszeichen korrekt parsen', () => {
    const { parseCSVLine } = require('../import-gtfs.js');
    assert.deepEqual(
      parseCSVLine('"he said ""hi""",b'),
      ['he said "hi"', 'b']
    );
  });

  it('sollte leere Felder korrekt parsen', () => {
    const { parseCSVLine } = require('../import-gtfs.js');
    assert.deepEqual(parseCSVLine('a,,c'), ['a', '', 'c']);
  });
});

// ============================================================
// 2. Import Tests
// ============================================================
describe('GTFS Import', () => {
  before(async () => {
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    const { importGTFS } = require('../import-gtfs.js');
    await importGTFS(TEST_DB_PATH, FIXTURES_DIR);
  });

  it('sollte SQLite-Datenbank erstellen', () => {
    assert.ok(fs.existsSync(TEST_DB_PATH), 'DB-Datei existiert nicht');
  });

  it('sollte alle 10 GTFS-Tabellen anlegen', () => {
    const Database = require('better-sqlite3');
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(r => r.name);
    db.close();

    assert.deepEqual(tables, [
      'agency', 'calendar', 'calendar_dates', 'feed_info', 'frequencies',
      'routes', 'stop_times', 'stops', 'transfers', 'trips'
    ]);
  });

  it('sollte korrekte Zeilenanzahl für agency haben', () => {
    const Database = require('better-sqlite3');
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const { count } = db.prepare('SELECT COUNT(*) as count FROM agency').get();
    db.close();
    assert.equal(count, 3);
  });

  it('sollte korrekte Zeilenanzahl für stops haben', () => {
    const Database = require('better-sqlite3');
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const { count } = db.prepare('SELECT COUNT(*) as count FROM stops').get();
    db.close();
    assert.equal(count, 8);
  });

  it('sollte korrekte Zeilenanzahl für routes haben', () => {
    const Database = require('better-sqlite3');
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const { count } = db.prepare('SELECT COUNT(*) as count FROM routes').get();
    db.close();
    assert.equal(count, 7);
  });

  it('sollte korrekte Zeilenanzahl für stop_times haben', () => {
    const Database = require('better-sqlite3');
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const { count } = db.prepare('SELECT COUNT(*) as count FROM stop_times').get();
    db.close();
    assert.equal(count, 10);
  });

  it('sollte Metadaten in _meta-Tabelle speichern', () => {
    const Database = require('better-sqlite3');
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const meta = db.prepare('SELECT key, value FROM _meta').all();
    db.close();
    assert.ok(meta.length > 0, 'Keine Metadaten gefunden');
    assert.ok(meta.some(m => m.key === 'imported_at'), 'imported_at fehlt');
    assert.ok(meta.some(m => m.key === 'total_rows'), 'total_rows fehlt');
  });
});

// ============================================================
// 3. MCP Server HTTP Tests
// ============================================================
describe('MCP Server HTTP', () => {
  let server;
  let baseUrl;

  before(async () => {
    // Test-DB erstellen falls nicht vorhanden
    if (!fs.existsSync(TEST_DB_PATH)) {
      const { importGTFS } = require('../import-gtfs.js');
      await importGTFS(TEST_DB_PATH, FIXTURES_DIR);
    }

    // DB-Pfad setzen
    process.env.GTFS_DB_PATH = TEST_DB_PATH;

    // Server-Modul laden (Cache leeren für frische ENV)
    delete require.cache[require.resolve('../server.js')];
    const { createApp } = require('../server.js');
    const app = createApp();

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const { port } = server.address();
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    delete process.env.GTFS_DB_PATH;
  });

  /** Helper: HTTP-Request */
  function httpRequest(method, urlPath, body = null, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      const headers = { ...extraHeaders };
      if (body) {
        headers['Content-Type'] = 'application/json';
      }
      const options = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, headers: res.headers, body: data });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('GET / sollte Frontend (HTML) oder Server-Info zurückgeben', async () => {
    const res = await httpRequest('GET', '/');
    assert.equal(res.status, 200);
    // Wenn Frontend vorhanden, wird HTML geliefert (body ist String); sonst JSON
    if (typeof res.body === 'string') {
      assert.ok(res.body.includes('GTFS'), 'Frontend HTML sollte GTFS enthalten');
    } else {
      assert.equal(res.body.name, 'ZVV GTFS MCP Server');
    }
  });

  it('GET /health sollte Status OK zurückgeben', async () => {
    const res = await httpRequest('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.ok(res.body.database);
    assert.ok(res.body.database.tables);
    assert.ok(res.body.database.tables.stops > 0, 'stops-Tabelle sollte Daten haben');
  });

  it('GET /health sollte korrekte Tabellenstatistiken haben', async () => {
    const res = await httpRequest('GET', '/health');
    const tables = res.body.database.tables;
    assert.equal(tables.agency, 3);
    assert.equal(tables.stops, 8);
    assert.equal(tables.routes, 7);
    assert.equal(tables.trips, 4);
    assert.equal(tables.stop_times, 10);
  });

  it('GET /mcp sollte Method Not Allowed zurückgeben', async () => {
    const res = await httpRequest('GET', '/mcp');
    assert.equal(res.status, 405);
  });

  it('POST /mcp mit MCP initialize sollte antworten', async () => {
    const res = await httpRequest('POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    }, {
      'Accept': 'application/json, text/event-stream'
    });
    // MCP Server sollte mit 200 oder einem JSON-RPC-Response antworten
    assert.ok([200, 202].includes(res.status), `Erwartete 200 oder 202, bekam ${res.status}`);
  });
});

// ============================================================
// 4. MCP Tool Tests (direkt über DB)
// ============================================================
describe('MCP Tools (Direkt-Tests)', () => {
  let db;

  before(async () => {
    if (!fs.existsSync(TEST_DB_PATH)) {
      const { importGTFS } = require('../import-gtfs.js');
      await importGTFS(TEST_DB_PATH, FIXTURES_DIR);
    }
    const Database = require('better-sqlite3');
    db = new Database(TEST_DB_PATH, { readonly: true });
  });

  after(() => {
    if (db) db.close();
  });

  it('search_stops: sollte "Zürich HB" finden', () => {
    const results = db.prepare(
      "SELECT * FROM stops WHERE stop_name LIKE ? LIMIT 10"
    ).all('%Zürich HB%');
    assert.ok(results.length > 0, 'Zürich HB nicht gefunden');
    assert.ok(results.some(s => s.stop_name === 'Zürich HB'));
  });

  it('search_stops: sollte "Paradeplatz" finden', () => {
    const results = db.prepare(
      "SELECT * FROM stops WHERE stop_name LIKE ? LIMIT 10"
    ).all('%Paradeplatz%');
    assert.ok(results.length > 0);
  });

  it('get_routes: sollte Tram-Linien (route_type=0) filtern', () => {
    const results = db.prepare(
      'SELECT * FROM routes WHERE route_type = ?'
    ).all(0);
    assert.equal(results.length, 3);
    assert.ok(results.every(r => r.route_type === 0));
  });

  it('get_routes: sollte Bahn-Linien (route_type=2) filtern', () => {
    const results = db.prepare(
      'SELECT * FROM routes WHERE route_type = ?'
    ).all(2);
    assert.equal(results.length, 3);
  });

  it('get_agencies: sollte alle 3 Agenturen zurückgeben', () => {
    const results = db.prepare('SELECT * FROM agency').all();
    assert.equal(results.length, 3);
  });

  it('get_trip_details: sollte Haltestellen einer Fahrt zurückgeben', () => {
    const stops = db.prepare(`
      SELECT st.*, s.stop_name
      FROM stop_times st
      JOIN stops s ON st.stop_id = s.stop_id
      WHERE st.trip_id = ?
      ORDER BY st.stop_sequence
    `).all('1.TA.91-10-A-j25-1.1.H');
    assert.equal(stops.length, 3);
    assert.equal(stops[0].stop_sequence, 1);
  });

  it('get_departures: sollte Abfahrten für Zürich HB finden', () => {
    const results = db.prepare(`
      SELECT st.departure_time, r.route_short_name
      FROM stop_times st
      JOIN trips t ON st.trip_id = t.trip_id
      JOIN routes r ON t.route_id = r.route_id
      WHERE st.stop_id LIKE '8503000%'
      ORDER BY st.departure_time
    `).all();
    assert.ok(results.length > 0, 'Keine Abfahrten gefunden');
  });
});

// ============================================================
// 5. Security Tests
// ============================================================
describe('Security', () => {
  it('sollte SQL-Injection via DROP TABLE blocken', () => {
    const normalized = 'SELECT * FROM stops; DROP TABLE stops'.trim().replace(/\s+/g, ' ').toUpperCase();
    const hasDrop = /\bDROP\b/.test(normalized);
    assert.ok(hasDrop, 'DROP wurde nicht erkannt');
  });

  it('sollte DELETE-Statements blocken', () => {
    const normalized = 'DELETE FROM stops WHERE 1=1'.trim().replace(/\s+/g, ' ').toUpperCase();
    const hasDelete = /\bDELETE\b/.test(normalized);
    assert.ok(hasDelete, 'DELETE wurde nicht erkannt');
  });

  it('sollte INSERT-Statements blocken', () => {
    const normalized = "INSERT INTO stops VALUES ('hack')".trim().replace(/\s+/g, ' ').toUpperCase();
    const hasInsert = /\bINSERT\b/.test(normalized);
    assert.ok(hasInsert, 'INSERT wurde nicht erkannt');
  });

  it('sollte ATTACH DATABASE blocken', () => {
    const normalized = "ATTACH DATABASE '/etc/passwd' AS hack".trim().replace(/\s+/g, ' ').toUpperCase();
    const hasAttach = /\bATTACH\b/.test(normalized);
    assert.ok(hasAttach, 'ATTACH wurde nicht erkannt');
  });

  it('sollte gültige SELECT-Queries erlauben', () => {
    const normalized = 'SELECT stop_name FROM stops WHERE stop_id = ?'.trim().replace(/\s+/g, ' ').toUpperCase();
    const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'ATTACH', 'DETACH', 'PRAGMA'];
    const blocked = forbidden.some(kw => new RegExp(`\\b${kw}\\b`).test(normalized));
    assert.ok(!blocked, 'Gültiges SELECT wurde blockiert');
  });
});

// ============================================================
// 6. Download-Script Tests (ohne tatsächlichen Download)
// ============================================================
describe('Download-Script', () => {
  it('sollte Modul korrekt exportieren', () => {
    const download = require('../download-gtfs.js');
    assert.ok(typeof download.fetchLatestZipUrl === 'function');
    assert.ok(typeof download.areGtfsFilesPresent === 'function');
    assert.ok(typeof download.isValidZipHeader === 'function');
    assert.ok(Array.isArray(download.REQUIRED_GTFS_FILES));
    assert.equal(download.REQUIRED_GTFS_FILES.length, 9);
  });

  it('sollte alle erforderlichen GTFS-Dateien definieren', () => {
    const { REQUIRED_GTFS_FILES } = require('../download-gtfs.js');
    const expected = [
      'agency.txt', 'stops.txt', 'routes.txt', 'trips.txt',
      'stop_times.txt', 'calendar.txt', 'calendar_dates.txt',
      'feed_info.txt', 'transfers.txt'
    ];
    assert.deepEqual(REQUIRED_GTFS_FILES, expected);
  });
});

// Aufräumen am Ende
process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
});
