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
// 5. Security Tests -- gegen die ECHTE Guard-Funktion, nicht gegen
//    eine im Test nachgebaute Regex.
// ============================================================
describe('Security (validateAndRunSQL)', () => {
  let validateAndRunSQL;

  before(async () => {
    if (!fs.existsSync(TEST_DB_PATH)) {
      const { importGTFS } = require('../import-gtfs.js');
      await importGTFS(TEST_DB_PATH, FIXTURES_DIR);
    }
    process.env.GTFS_DB_PATH = TEST_DB_PATH;
    delete require.cache[require.resolve('../server.js')];
    ({ validateAndRunSQL } = require('../server.js'));
  });

  after(() => {
    delete process.env.GTFS_DB_PATH;
    delete require.cache[require.resolve('../server.js')];
  });

  for (const kw of ['DROP', 'DELETE', 'INSERT', 'UPDATE', 'ALTER', 'CREATE', 'ATTACH', 'PRAGMA']) {
    it(`sollte ${kw} blocken`, () => {
      const r = validateAndRunSQL(`${kw} something evil`, 10);
      assert.ok(r.error, `${kw} haette blockiert werden muessen`);
    });
  }

  it('sollte gültige SELECT-Queries ausführen', () => {
    const r = validateAndRunSQL('SELECT stop_name FROM stops', 5);
    assert.ok(!r.error, r.error);
    assert.ok(r.count > 0, 'SELECT sollte Zeilen liefern');
  });

  it('sollte WITH...SELECT (CTE) erlauben', () => {
    const r = validateAndRunSQL('WITH x AS (SELECT 1 AS n) SELECT n FROM x', 5);
    assert.ok(!r.error, r.error);
    assert.equal(r.results[0].n, 1);
  });

  it('sollte Keyword in String-Literal NICHT blocken (Falsch-Positiv)', () => {
    const r = validateAndRunSQL("SELECT stop_name FROM stops WHERE stop_name LIKE '%CREATE%'", 5);
    assert.ok(!r.error, `Keyword im Literal wurde faelschlich blockiert: ${r.error}`);
  });

  it('sollte einen negativen limit nicht roh in die SQL lassen', () => {
    const r = validateAndRunSQL('SELECT stop_id FROM stops', -1);
    assert.ok(!r.error, r.error);
    assert.ok(r.count >= 1 && r.count <= 1000, 'limit muss auf 1..1000 geklemmt werden');
  });

  it('sollte einen riesigen limit auf 1000 klemmen', () => {
    const r = validateAndRunSQL('SELECT stop_id FROM stops', 99999999);
    assert.ok(!r.error, r.error);
    assert.ok(r.count <= 1000, 'limit-Kappung auf 1000 verletzt');
  });
});

// ============================================================
// 5b. Reine Hilfsfunktionen (GTFS-Zeit, DIDOK, route_type)
// ============================================================
describe('Hilfsfunktionen', () => {
  let S;
  before(() => {
    delete require.cache[require.resolve('../server.js')];
    S = require('../server.js');
  });
  after(() => { delete require.cache[require.resolve('../server.js')]; });

  it('didokToSloid übersetzt bekannte Bahnhöfe', () => {
    assert.equal(S.didokToSloid('8503000'), 'ch:1:sloid:3000');  // Zürich HB
    assert.equal(S.didokToSloid('8500010'), 'ch:1:sloid:10');    // Basel SBB
    assert.equal(S.didokToSloid('8507000'), 'ch:1:sloid:7000');  // Bern
  });

  it('didokToSloid gibt null für Nicht-DIDOK zurück', () => {
    assert.equal(S.didokToSloid('ch:1:sloid:3000'), null);
    assert.equal(S.didokToSloid('9999999'), null);
    assert.equal(S.didokToSloid('850300'), null);   // zu kurz
  });

  it('GTFS-Zeiten über 24:00 korrekt umrechnen', () => {
    assert.equal(S.hmsToSec('24:30:00'), 88200);
    assert.equal(S.shift24('00:30:00'), '24:30:00');
    assert.equal(S.normalizeTime('24:30:00'), '00:30:00');
    assert.equal(S.normalizeTime('25:10:00'), '01:10:00');
    assert.equal(S.normalizeTime('13:04:00'), '13:04:00');  // unter 24 unverändert
  });

  it('prevYmd über Monatsgrenze', () => {
    assert.equal(S.prevYmd('20260801'), '20260731');
    assert.equal(S.prevYmd('20260101'), '20251231');
  });

  it('weekdayCol liefert die richtige Wochentagsspalte', () => {
    assert.equal(S.weekdayCol('20260722'), 'wednesday');  // 22.07.2026 ist Mittwoch
    assert.equal(S.weekdayCol('20260721'), 'tuesday');
  });

  it('HVT_RANGES bildet klassische Typen auf HVT-Bereiche ab', () => {
    assert.deepEqual(S.HVT_RANGES[2], [100, 199]);   // Bahn
    assert.deepEqual(S.HVT_RANGES[3], [700, 799]);   // Bus
    assert.deepEqual(S.HVT_RANGES[0], [900, 999]);   // Tram
  });
});

// ============================================================
// 5c. Auth-Middleware -- gegen eine App MIT gesetztem Token.
// ============================================================
describe('Auth-Middleware', () => {
  let server, baseUrl;
  const TOKEN = 'test-secret-token-123';

  before(async () => {
    if (!fs.existsSync(TEST_DB_PATH)) {
      const { importGTFS } = require('../import-gtfs.js');
      await importGTFS(TEST_DB_PATH, FIXTURES_DIR);
    }
    process.env.GTFS_DB_PATH = TEST_DB_PATH;
    process.env.MCP_AUTH_TOKEN = TOKEN;
    delete require.cache[require.resolve('../server.js')];
    const { createApp } = require('../server.js');
    const app = createApp();
    await new Promise(resolve => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); }); });
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.GTFS_DB_PATH;
    delete require.cache[require.resolve('../server.js')];
  });

  function post(urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      const req = http.request({ method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname,
        headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
      req.on('error', reject); req.write(JSON.stringify(body)); req.end();
    });
  }
  function get(urlPath) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
        let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode }));
      }).on('error', reject);
    });
  }

  it('/api/query ohne Token → 401', async () => {
    const res = await post('/api/query', { sql: 'SELECT 1' });
    assert.equal(res.status, 401);
    assert.match(res.headers['www-authenticate'] || '', /Bearer/);
  });

  it('/api/query mit falschem Token → 401', async () => {
    const res = await post('/api/query', { sql: 'SELECT 1' }, { Authorization: 'Bearer falsch' });
    assert.equal(res.status, 401);
  });

  it('/api/query mit korrektem Token → 200', async () => {
    const res = await post('/api/query', { sql: 'SELECT 1 AS n' }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200);
  });

  it('/mcp ohne Token → 401', async () => {
    const res = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Accept: 'application/json, text/event-stream' });
    assert.equal(res.status, 401);
  });

  it('/health bleibt ohne Token offen → 200', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
  });

  it('sperrt eine IP nach zu vielen Fehlversuchen (Brute-Force-Schutz)', async () => {
    // Eigene IP verwenden, damit die anderen Tests nicht betroffen sind.
    const ip = '203.0.113.77';
    let sawLock = false;
    for (let i = 0; i < 12; i++) {
      const res = await post('/api/query', { sql: 'SELECT 1' },
        { Authorization: 'Bearer falsch', 'CF-Connecting-IP': ip });
      if (res.status === 429) { sawLock = true; break; }
      assert.equal(res.status, 401);
    }
    assert.ok(sawLock, 'nach 10 Fehlversuchen haette 429 kommen muessen');

    // Auch ein KORREKTER Token bleibt waehrend der Sperre abgewiesen.
    const locked = await post('/api/query', { sql: 'SELECT 1' },
      { Authorization: `Bearer ${TOKEN}`, 'CF-Connecting-IP': ip });
    assert.equal(locked.status, 429);

    // Eine andere IP ist davon unberuehrt.
    const other = await post('/api/query', { sql: 'SELECT 1 AS n' },
      { Authorization: `Bearer ${TOKEN}`, 'CF-Connecting-IP': '203.0.113.78' });
    assert.equal(other.status, 200);
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
