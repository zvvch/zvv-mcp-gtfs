/**
 * MCP-Tools fuer die GTFS-Daten.
 *
 * Getrennt von server.js, weil es zwei Auspraegungen gibt:
 *  - oeffentlich (/mcp): nur lesende Fachabfragen, ohne Anmeldung
 *  - Admin (/mcp-admin): zusaetzlich die freie SQL-Abfrage, mit Token
 *
 * Warum die Trennung ueber zwei Endpunkte und nicht ueber Tool-Metadaten:
 * @modelcontextprotocol/sdk 1.29 kennt kein securitySchemes auf Tool-Ebene.
 * registerTool destrukturiert genau { title, description, inputSchema,
 * outputSchema, annotations, _meta } -- alles andere wird still verworfen.
 * Zwei Endpunkte sind damit der einzige verlaessliche Weg.
 *
 * Zu outputSchema: sobald ein Tool eines deklariert, MUSS jede erfolgreiche
 * Antwort ein dazu passendes structuredContent enthalten, sonst antwortet der
 * Server mit -32602 statt mit Daten. GTFS-Felder sind haeufig leer, deshalb
 * sind praktisch alle Felder hier nullable.
 */

const { z } = require('zod');

// --- Gemeinsame Bausteine fuer die Ausgabeschemata ---
const nstr = z.string().nullable().optional();
const nnum = z.number().nullable().optional();

const StopShape = {
  stop_id: z.string(),
  stop_name: nstr,
  stop_lat: nnum,
  stop_lon: nnum,
  variants: nnum,
};

const DepartureShape = {
  departure_time: nstr,
  arrival_time: nstr,
  trip_id: nstr,
  trip_headsign: nstr,
  route_short_name: nstr,
  route_long_name: nstr,
  route_type: nnum,
  agency_name: nstr,
};

/** Einheitliche Antwortform: Text-Fallback plus strukturierte Daten. */
function ok(obj) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj,
  };
}

/**
 * Registriert alle Tools auf einem McpServer.
 *
 * @param {object} server   McpServer-Instanz
 * @param {object} d        Abhaengigkeiten aus server.js (keine Zirkelbezuege)
 * @param {object} opts     { admin: boolean }
 */
function registerTools(server, d, opts = {}) {
  const admin = !!opts.admin;
  const {
    getDb, resolveRelatedStops, getMeta, getDbStats, validateAndRunSQL,
    normalizeForSearch, hasStopNameNorm, NORMALIZE_SQL, HVT_RANGES,
    swissDateYmd, weekdayCol, prevYmd, shift24, normalizeTime, hmsToSec,
  } = d;

  // Alle lesenden Tools teilen dieselben Hinweise.
  const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  /** Aktuelle Schweizer Uhrzeit als HH:MM:SS */
  const nowSwissTime = () => new Date().toLocaleTimeString('de-CH', {
    timeZone: 'Europe/Zurich', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  /**
   * Sucht Haltestellen nach Namen, zusammengefasst je Name.
   *
   * Wortweise statt als ein Stueck: "zurich bellevue" muss auch
   * "Zürich, Bellevue" finden -- das Komma im offiziellen Namen wuerde einen
   * durchgehenden Substring-Vergleich sonst scheitern lassen, und genau so
   * tippt ein Sprachmodell die Anfrage.
   */
  function searchStopsByName(db, query, limit) {
    const col = hasStopNameNorm(db) ? 'stop_name_norm' : NORMALIZE_SQL('stop_name');
    const full = normalizeForSearch(query);
    const words = full.split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) return [];

    const run = (terms) => {
      const where = terms.map(() => `${col} LIKE ?`).join(' AND ');
      return db.prepare(`
        SELECT stop_name, MIN(stop_id) AS stop_id, COUNT(*) AS variants,
               MIN(stop_lat) AS stop_lat, MIN(stop_lon) AS stop_lon
        FROM stops WHERE ${where}
        GROUP BY stop_name
        ORDER BY CASE WHEN ${col} LIKE ? THEN 0 ELSE 1 END, LENGTH(stop_name), stop_name
        LIMIT ?
      `).all(...terms.map(t => `%${t}%`), `${full}%`, limit);
    };

    let rows = run(words);
    if (!rows.length) {
      // Rueckfall fuer die deutsche Umschreibung: "zuerich" -> "zurich".
      const collapsed = words.map(w => w.replace(/ue/g, 'u').replace(/oe/g, 'o').replace(/ae/g, 'a'));
      if (collapsed.join() !== words.join()) rows = run(collapsed);
    }

    // Feinsortierung ausserhalb von SQL. Entscheidend ist der Vergleich ohne
    // Satzzeichen: die Anfrage "zurich bellevue" meint "Zürich, Bellevue"
    // (Tram) und nicht "Zürich Bellevue (See)" (Schiff) -- ersteres ist nach
    // Entfernen des Kommas identisch, letzteres traegt einen Zusatz.
    const bare = (s) => normalizeForSearch(s).replace(/[^a-z0-9]+/g, ' ').trim();
    const q = bare(query);
    const score = (name) => {
      const n = bare(name);
      if (n === q) return 0;
      if (n.startsWith(q + ' ')) return 1;
      if (n.startsWith(q)) return 2;
      return 3;
    };
    return rows
      .map(r => ({ r, s: score(r.stop_name) }))
      .sort((a, b) => a.s - b.s || a.r.stop_name.length - b.r.stop_name.length)
      .map(x => x.r);
  }

  /**
   * Loest eine Ortsangabe zu Haltekanten auf. Nimmt eine stop_id ODER einen
   * Namen entgegen -- ein Sprachmodell hat selten die ID zur Hand.
   *
   * Bei Namen wird per Praefix aufgeloest und nach Namenslaenge gedeckelt.
   * Das ist bewusst so: "Zürich Stadelhofen" muss auch die Tramhaltestelle
   * "Zürich Stadelhofen, Bahnhof" erfassen (sonst findet man keine Tram),
   * waehrend "Bern" nicht saemtliche 1025 Kanten von Bernex bis Berneck
   * einsammeln darf. Kuerzester Name zuerst = die Hauptstation.
   */
  function resolvePlace(db, input) {
    const raw = String(input || '').trim();
    if (!raw) return { ids: [], label: raw };

    // Sieht es nach einer ID aus, erst den ID-Pfad versuchen.
    const viaId = resolveRelatedStops(db, raw);
    if (viaId.matched) {
      const row = db.prepare('SELECT stop_name FROM stops WHERE stop_id = ?').get(raw);
      return { ids: viaId.ids, label: (row && row.stop_name) || raw };
    }

    // Ueber die Namenssuche den passendsten Haltestellennamen bestimmen und
    // DESSEN Kanten einsammeln. Der Umweg ist wichtig: eine Praefixsuche auf
    // "Bern" wuerde sonst 1025 Kanten von Bernex bis Berneck einsammeln und
    // die Verbindungssuche in die Sekunden treiben.
    // Mehrere Kandidaten holen: die Feinsortierung in searchStopsByName
    // greift erst NACH dem SQL-LIMIT. Mit LIMIT 1 kaeme die Schiffstation
    // "Zürich Bellevue (See)" durch statt der Tramhaltestelle.
    const best = searchStopsByName(db, raw, 10)[0];
    if (!best) return { ids: [], label: raw };

    const col = hasStopNameNorm(db) ? 'stop_name_norm' : NORMALIZE_SQL('stop_name');
    const needle = normalizeForSearch(best.stop_name);
    // Alle Kanten dieses Namens plus dessen Untervarianten -- "Zürich
    // Stadelhofen" muss auch "Zürich Stadelhofen, Bahnhof" umfassen, sonst
    // findet man von dort keine Tram.
    const rows = db.prepare(
      `SELECT stop_id, stop_name FROM stops WHERE ${col} = ? OR ${col} LIKE ?
       ORDER BY LENGTH(stop_name), stop_name LIMIT 40`
    ).all(needle, `${needle},%`);

    return { ids: rows.map(r => r.stop_id), label: best.stop_name };
  }

  /** Abfahrten eines Betriebstags ab einer GTFS-Zeit */
  function departuresForDay(db, stopIds, ymd, minTime, limit) {
    const ph = stopIds.map(() => '?').join(',');
    return db.prepare(`
      SELECT st.departure_time, st.arrival_time, st.stop_sequence,
             t.trip_id, t.trip_headsign, t.direction_id,
             r.route_short_name, r.route_long_name, r.route_type, a.agency_name
      FROM stop_times st
      JOIN trips t ON st.trip_id = t.trip_id
      JOIN routes r ON t.route_id = r.route_id
      LEFT JOIN agency a ON r.agency_id = a.agency_id
      WHERE st.stop_id IN (${ph}) AND st.departure_time >= ?
        AND (
          (t.service_id IN (SELECT service_id FROM calendar
                            WHERE ${weekdayCol(ymd)} = 1 AND start_date <= ? AND end_date >= ?)
           AND t.service_id NOT IN (SELECT service_id FROM calendar_dates
                                    WHERE date = ? AND exception_type = 2))
          OR t.service_id IN (SELECT service_id FROM calendar_dates
                              WHERE date = ? AND exception_type = 1)
        )
      ORDER BY st.departure_time
      LIMIT ?
    `).all(...stopIds, minTime, ymd, ymd, ymd, ymd, limit);
  }

  // ---------------------------------------------------------------- //
  // 1. search_stops
  // ---------------------------------------------------------------- //
  server.registerTool('search_stops', {
    title: 'Haltestellen suchen',
    description: 'Sucht Schweizer ÖV-Haltestellen nach Namen und gibt ihre stop_id zurück. Toleriert fehlende Umlaute ("zurich" findet "Zürich"). Ergebnisse sind je Haltestelle zusammengefasst.',
    inputSchema: {
      query: z.string().describe('Name oder Namensteil, z.B. "Zürich Bellevue"'),
      limit: z.number().int().min(1).max(50).default(10).describe('Maximale Anzahl Haltestellen'),
    },
    outputSchema: { count: z.number(), stops: z.array(z.object(StopShape)) },
    annotations: READ,
  }, async ({ query, limit }) => {
    const db = getDb();
    const rows = searchStopsByName(db, query, limit);
    return ok({ count: rows.length, stops: rows });
  });

  // ---------------------------------------------------------------- //
  // 2. get_stop_departures
  // ---------------------------------------------------------------- //
  server.registerTool('get_stop_departures', {
    title: 'Abfahrten ab Haltestelle',
    description: 'Nächste Abfahrten ab einer Haltestelle mit Linie, Ziel und Zeit. Akzeptiert stop_id oder Haltestellennamen. Ohne Zeitangabe ab jetzt (Schweizer Zeit). Enthält Nachtkurse nach Mitternacht.',
    inputSchema: {
      stop: z.string().describe('stop_id oder Haltestellenname, z.B. "Zürich, Bellevue"'),
      date: z.string().optional().describe('Datum YYYYMMDD, Vorgabe: heute'),
      time_from: z.string().optional().describe('Startzeit HH:MM:SS, Vorgabe: jetzt'),
      limit: z.number().int().min(1).max(100).default(20).describe('Maximale Anzahl Abfahrten'),
    },
    outputSchema: {
      stop: nstr, stop_query: z.string(), date: z.string(), time_from: z.string(),
      count: z.number(), departures: z.array(z.object(DepartureShape)),
    },
    annotations: READ,
  }, async ({ stop, date, time_from, limit }) => {
    const db = getDb();
    const place = resolvePlace(db, stop);
    if (!place.ids.length) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Haltestelle '${stop}' nicht gefunden.` }) }], isError: true };
    }

    const ymd = date || swissDateYmd();
    const start = time_from || (date ? '00:00:00' : nowSwissTime());

    const today = departuresForDay(db, place.ids, ymd, start, limit)
      .map(r => ({ ...r, _s: hmsToSec(r.departure_time) }));

    // Nachtkurse: ein Kurs um 00:30 gehoert zum Service-Tag davor (24:30).
    const prev = departuresForDay(db, place.ids, prevYmd(ymd), shift24(start), limit)
      .map(r => ({
        ...r,
        departure_time: normalizeTime(r.departure_time),
        arrival_time: r.arrival_time ? normalizeTime(r.arrival_time) : r.arrival_time,
        _s: hmsToSec(r.departure_time) - 24 * 3600,
      }));

    const departures = [...prev, ...today].sort((a, b) => a._s - b._s).slice(0, limit)
      .map(({ _s, stop_sequence, direction_id, ...rest }) => rest);

    return ok({ stop: place.label, stop_query: stop, date: ymd, time_from: start, count: departures.length, departures });
  });

  // ---------------------------------------------------------------- //
  // 3. get_connections
  // ---------------------------------------------------------------- //
  server.registerTool('get_connections', {
    title: 'Direkte Verbindungen',
    description: 'Direkte Verbindungen zwischen zwei Haltestellen (ohne Umsteigen) mit Abfahrts- und Ankunftszeit. Akzeptiert Namen oder stop_id. Für Fragen wie "wie komme ich von A nach B".',
    inputSchema: {
      from: z.string().describe('Start, z.B. "Zürich, Bellevue"'),
      to: z.string().describe('Ziel, z.B. "Zürich Stadelhofen"'),
      date: z.string().optional().describe('Datum YYYYMMDD, Vorgabe: heute'),
      time_from: z.string().optional().describe('Frühestens ab HH:MM:SS, Vorgabe: jetzt'),
      limit: z.number().int().min(1).max(20).default(6).describe('Maximale Anzahl Verbindungen'),
    },
    outputSchema: {
      from: nstr, to: nstr, date: z.string(), time_from: z.string(), count: z.number(),
      note: nstr,
      connections: z.array(z.object({
        departure_time: nstr, arrival_time: nstr, duration_minutes: nnum,
        route_short_name: nstr, route_long_name: nstr, route_type: nnum,
        trip_id: nstr, trip_headsign: nstr, agency_name: nstr,
      })),
    },
    annotations: READ,
  }, async ({ from, to, date, time_from, limit }) => {
    const db = getDb();
    const A = resolvePlace(db, from);
    const B = resolvePlace(db, to);
    if (!A.ids.length) return { content: [{ type: 'text', text: JSON.stringify({ error: `Start '${from}' nicht gefunden.` }) }], isError: true };
    if (!B.ids.length) return { content: [{ type: 'text', text: JSON.stringify({ error: `Ziel '${to}' nicht gefunden.` }) }], isError: true };

    const ymd = date || swissDateYmd();
    const start = time_from || (date ? '00:00:00' : nowSwissTime());
    const pa = A.ids.map(() => '?').join(',');

    // Stufe 1: Kandidaten-Fahrten ab dem Start. Die Deckelung haelt die
    // zweite Stufe klein -- ohne sie laeuft die Abfrage in die Sekunden.
    const deps = db.prepare(`
      SELECT sa.trip_id, sa.departure_time AS dep, sa.stop_sequence AS seq
      FROM stop_times sa
      JOIN trips t ON t.trip_id = sa.trip_id
      WHERE sa.stop_id IN (${pa}) AND sa.departure_time >= ?
        AND (
          (t.service_id IN (SELECT service_id FROM calendar
                            WHERE ${weekdayCol(ymd)} = 1 AND start_date <= ? AND end_date >= ?)
           AND t.service_id NOT IN (SELECT service_id FROM calendar_dates
                                    WHERE date = ? AND exception_type = 2))
          OR t.service_id IN (SELECT service_id FROM calendar_dates
                              WHERE date = ? AND exception_type = 1)
        )
      ORDER BY sa.departure_time
      LIMIT 250
    `).all(...A.ids, start, ymd, ymd, ymd, ymd);

    const first = new Map();
    for (const r of deps) if (!first.has(r.trip_id)) first.set(r.trip_id, r);
    const tripIds = [...first.keys()];

    let connections = [];
    if (tripIds.length) {
      const pt = tripIds.map(() => '?').join(',');
      // Stufe 2: Halten diese Fahrten spaeter am Ziel?
      // Bewusst NUR nach trip_id gefiltert, damit SQLite sicher den
      // Trip-Index nimmt. Mit zusaetzlichem "stop_id IN (...)" waehlt der
      // Planer den Stop-Index und scannt Millionen Zeilen -- gemessen 19 s
      // statt unter einer Sekunde. Die Zielhalte filtern wir hier.
      // Erst nur die Halte selbst, ohne Joins -- das haelt die Zeilen schmal.
      const targetSet = new Set(B.ids);
      const arrivals = db.prepare(
        `SELECT trip_id, stop_id, arrival_time AS arr, stop_sequence AS seq
         FROM stop_times WHERE trip_id IN (${pt})`
      ).all(...tripIds).filter(x => targetSet.has(x.stop_id));

      const seen = new Set();
      const hits = [];
      for (const a of arrivals) {
        const s = first.get(a.trip_id);
        if (!s || a.seq <= s.seq) continue;      // Ziel muss NACH dem Start liegen
        if (seen.has(a.trip_id)) continue;       // je Fahrt nur eine Verbindung
        seen.add(a.trip_id);
        hits.push({ trip_id: a.trip_id, dep: s.dep, arr: a.arr });
      }
      hits.sort((x, y) => x.dep.localeCompare(y.dep));
      const top = hits.slice(0, limit);

      // Linien- und Unternehmensangaben erst fuer die wenigen Treffer holen.
      if (top.length) {
        const ph2 = top.map(() => '?').join(',');
        const meta = new Map();
        for (const m of db.prepare(`
          SELECT t.trip_id, t.trip_headsign, r.route_short_name, r.route_long_name,
                 r.route_type, a.agency_name
          FROM trips t JOIN routes r ON r.route_id = t.route_id
          LEFT JOIN agency a ON a.agency_id = r.agency_id
          WHERE t.trip_id IN (${ph2})
        `).all(...top.map(h => h.trip_id))) meta.set(m.trip_id, m);

        connections = top.map(h => {
          const m = meta.get(h.trip_id) || {};
          const dur = (hmsToSec(h.arr) - hmsToSec(h.dep)) / 60;
          return {
            departure_time: h.dep, arrival_time: h.arr,
            duration_minutes: Number.isFinite(dur) ? Math.round(dur) : null,
            route_short_name: m.route_short_name ?? null,
            route_long_name: m.route_long_name ?? null,
            route_type: m.route_type ?? null,
            trip_id: h.trip_id,
            trip_headsign: m.trip_headsign ?? null,
            agency_name: m.agency_name ?? null,
          };
        });
      }
    }

    return ok({
      from: A.label, to: B.label, date: ymd, time_from: start,
      count: connections.length,
      note: connections.length ? null : 'Keine direkte Verbindung gefunden. Umsteigeverbindungen werden von diesem Tool nicht berechnet.',
      connections,
    });
  });

  // ---------------------------------------------------------------- //
  // 4. get_trip
  // ---------------------------------------------------------------- //
  server.registerTool('get_trip', {
    title: 'Fahrt mit allen Halten',
    description: 'Alle Halte einer Fahrt in Reihenfolge, mit Ankunfts- und Abfahrtszeit. Die trip_id stammt aus get_stop_departures oder get_connections.',
    inputSchema: { trip_id: z.string().describe('Fahrt-ID (trip_id)') },
    outputSchema: {
      trip: z.object({
        trip_id: nstr, trip_headsign: nstr, route_short_name: nstr,
        route_long_name: nstr, route_type: nnum, agency_name: nstr,
      }).nullable(),
      stop_count: z.number(),
      stops: z.array(z.object({
        stop_sequence: nnum, arrival_time: nstr, departure_time: nstr,
        stop_id: nstr, stop_name: nstr, stop_lat: nnum, stop_lon: nnum,
      })),
    },
    annotations: READ,
  }, async ({ trip_id }) => {
    const db = getDb();
    const trip = db.prepare(`
      SELECT t.trip_id, t.trip_headsign, r.route_short_name, r.route_long_name, r.route_type, a.agency_name
      FROM trips t JOIN routes r ON t.route_id = r.route_id
      LEFT JOIN agency a ON r.agency_id = a.agency_id
      WHERE t.trip_id = ?
    `).get(trip_id);
    if (!trip) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Fahrt '${trip_id}' nicht gefunden.` }) }], isError: true };
    }
    const stops = db.prepare(`
      SELECT st.stop_sequence, st.arrival_time, st.departure_time,
             s.stop_id, s.stop_name, s.stop_lat, s.stop_lon
      FROM stop_times st JOIN stops s ON st.stop_id = s.stop_id
      WHERE st.trip_id = ? ORDER BY st.stop_sequence
    `).all(trip_id);
    return ok({ trip, stop_count: stops.length, stops });
  });

  // ---------------------------------------------------------------- //
  // 5. get_routes
  // ---------------------------------------------------------------- //
  server.registerTool('get_routes', {
    title: 'Linien suchen',
    description: 'ÖV-Linien, optional gefiltert nach Liniennummer, Verkehrsunternehmen oder Verkehrsmittel. Für route_type sind sowohl 0=Tram, 1=Metro, 2=Bahn, 3=Bus, 4=Schiff, 6=Gondel, 7=Standseilbahn als auch die erweiterten HVT-Werte des Schweizer Feeds erlaubt.',
    inputSchema: {
      name: z.string().optional().describe('Liniennummer oder -name, z.B. "S12" oder "IC8"'),
      agency_id: z.string().optional().describe('Filter nach Verkehrsunternehmen'),
      route_type: z.number().int().optional().describe('Verkehrsmittel, klassisch 0-7 oder HVT'),
      limit: z.number().int().min(1).max(200).default(30).describe('Maximale Anzahl Linien'),
    },
    outputSchema: {
      count: z.number(),
      routes: z.array(z.object({
        route_id: nstr, route_short_name: nstr, route_long_name: nstr,
        route_type: nnum, agency_id: nstr, agency_name: nstr,
      })),
    },
    annotations: READ,
  }, async ({ name, agency_id, route_type, limit }) => {
    const db = getDb();
    let sql = `SELECT r.route_id, r.route_short_name, r.route_long_name, r.route_type,
                      r.agency_id, a.agency_name
               FROM routes r LEFT JOIN agency a ON r.agency_id = a.agency_id WHERE 1=1`;
    const p = [];
    if (name) { sql += ' AND (r.route_short_name = ? OR r.route_short_name LIKE ?)'; p.push(name, `${name}%`); }
    if (agency_id) { sql += ' AND r.agency_id = ?'; p.push(agency_id); }
    if (route_type !== undefined) {
      const range = HVT_RANGES[route_type];
      if (range) { sql += ' AND r.route_type BETWEEN ? AND ?'; p.push(range[0], range[1]); }
      else { sql += ' AND r.route_type = ?'; p.push(route_type); }
    }
    sql += ' ORDER BY r.route_short_name LIMIT ?';
    p.push(limit);
    const routes = db.prepare(sql).all(...p);
    return ok({ count: routes.length, routes });
  });

  // ---------------------------------------------------------------- //
  // 6. get_agencies
  // ---------------------------------------------------------------- //
  server.registerTool('get_agencies', {
    title: 'Verkehrsunternehmen',
    description: 'Alle Verkehrsunternehmen im Fahrplan mit der Anzahl ihrer Linien.',
    inputSchema: { limit: z.number().int().min(1).max(1000).default(100).describe('Maximale Anzahl') },
    outputSchema: {
      count: z.number(),
      agencies: z.array(z.object({
        agency_id: nstr, agency_name: nstr, agency_url: nstr, route_count: nnum,
      })),
    },
    annotations: READ,
  }, async ({ limit }) => {
    const db = getDb();
    const agencies = db.prepare(`
      SELECT a.agency_id, a.agency_name, a.agency_url, COUNT(r.route_id) AS route_count
      FROM agency a LEFT JOIN routes r ON a.agency_id = r.agency_id
      GROUP BY a.agency_id ORDER BY route_count DESC LIMIT ?
    `).all(limit);
    return ok({ count: agencies.length, agencies });
  });

  // ---------------------------------------------------------------- //
  // 7. get_dataset_info
  // ---------------------------------------------------------------- //
  server.registerTool('get_dataset_info', {
    title: 'Datenstand',
    description: 'Welcher Fahrplan geladen ist, wann er heruntergeladen wurde und wie viele Datensätze je Tabelle vorliegen. Nur statische Fahrplandaten, keine Echtzeit.',
    inputSchema: {},
    outputSchema: {
      feed: nstr, downloaded_at: nstr, imported_at: nstr,
      source: nstr, realtime: z.boolean(),
      tables: z.record(z.string(), z.number()),
    },
    annotations: READ,
  }, async () => {
    const meta = getMeta();
    return ok({
      feed: meta.gtfs_filename || null,
      downloaded_at: meta.gtfs_downloaded_at || null,
      imported_at: meta.imported_at || null,
      source: 'opentransportdata.swiss',
      realtime: false,
      tables: getDbStats(),
    });
  });

  // ---------------------------------------------------------------- //
  // 8. query_gtfs -- NUR auf dem geschuetzten Endpunkt
  // ---------------------------------------------------------------- //
  if (admin) {
    server.registerTool('query_gtfs', {
      title: 'Freie SQL-Abfrage',
      description: 'Führt eine lesende SQL-Abfrage auf den GTFS-Daten aus. Nur SELECT bzw. WITH...SELECT. Tabellen: agency, stops, routes, trips, stop_times, calendar, calendar_dates, feed_info, transfers, frequencies.',
      inputSchema: {
        sql: z.string().describe('SQL SELECT-Abfrage'),
        limit: z.number().int().min(1).max(1000).default(100).describe('Maximale Anzahl Zeilen'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ sql, limit }) => {
      const result = validateAndRunSQL(sql, limit);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      };
    });
  }
}

module.exports = { registerTools };
