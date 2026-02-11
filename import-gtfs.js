const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

const GTFS_DIR = path.join(__dirname, 'zvv-data', 'gtfs');
const DB_PATH = path.join(__dirname, 'zvv-data', 'gtfs.db');

// GTFS-Tabellen-Definitionen: Name -> { file, columns, indexes }
const GTFS_TABLES = {
  agency: {
    file: 'agency.txt',
    columns: {
      agency_id: 'TEXT PRIMARY KEY',
      agency_name: 'TEXT NOT NULL',
      agency_url: 'TEXT',
      agency_timezone: 'TEXT',
      agency_lang: 'TEXT',
      agency_phone: 'TEXT'
    },
    indexes: []
  },
  stops: {
    file: 'stops.txt',
    columns: {
      stop_id: 'TEXT PRIMARY KEY',
      stop_code: 'TEXT',
      stop_name: 'TEXT NOT NULL',
      stop_desc: 'TEXT',
      stop_lat: 'REAL',
      stop_lon: 'REAL',
      zone_id: 'TEXT',
      stop_url: 'TEXT',
      location_type: 'INTEGER',
      parent_station: 'TEXT',
      stop_timezone: 'TEXT',
      wheelchair_boarding: 'INTEGER',
      platform_code: 'TEXT'
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_stops_name ON stops(stop_name)',
      'CREATE INDEX IF NOT EXISTS idx_stops_parent ON stops(parent_station)'
    ]
  },
  routes: {
    file: 'routes.txt',
    columns: {
      route_id: 'TEXT PRIMARY KEY',
      agency_id: 'TEXT',
      route_short_name: 'TEXT',
      route_long_name: 'TEXT',
      route_desc: 'TEXT',
      route_type: 'INTEGER NOT NULL',
      route_url: 'TEXT',
      route_color: 'TEXT',
      route_text_color: 'TEXT'
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_routes_agency ON routes(agency_id)',
      'CREATE INDEX IF NOT EXISTS idx_routes_type ON routes(route_type)'
    ]
  },
  trips: {
    file: 'trips.txt',
    columns: {
      route_id: 'TEXT NOT NULL',
      service_id: 'TEXT NOT NULL',
      trip_id: 'TEXT PRIMARY KEY',
      trip_headsign: 'TEXT',
      trip_short_name: 'TEXT',
      direction_id: 'INTEGER',
      block_id: 'TEXT',
      shape_id: 'TEXT',
      wheelchair_accessible: 'INTEGER',
      bikes_allowed: 'INTEGER'
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_trips_route ON trips(route_id)',
      'CREATE INDEX IF NOT EXISTS idx_trips_service ON trips(service_id)'
    ]
  },
  stop_times: {
    file: 'stop_times.txt',
    columns: {
      trip_id: 'TEXT NOT NULL',
      arrival_time: 'TEXT',
      departure_time: 'TEXT',
      stop_id: 'TEXT NOT NULL',
      stop_sequence: 'INTEGER NOT NULL',
      stop_headsign: 'TEXT',
      pickup_type: 'INTEGER',
      drop_off_type: 'INTEGER'
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_stop_times_trip ON stop_times(trip_id)',
      'CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON stop_times(stop_id)',
      'CREATE INDEX IF NOT EXISTS idx_stop_times_departure ON stop_times(departure_time)'
    ]
  },
  calendar: {
    file: 'calendar.txt',
    columns: {
      service_id: 'TEXT PRIMARY KEY',
      monday: 'INTEGER',
      tuesday: 'INTEGER',
      wednesday: 'INTEGER',
      thursday: 'INTEGER',
      friday: 'INTEGER',
      saturday: 'INTEGER',
      sunday: 'INTEGER',
      start_date: 'TEXT',
      end_date: 'TEXT'
    },
    indexes: []
  },
  calendar_dates: {
    file: 'calendar_dates.txt',
    columns: {
      service_id: 'TEXT NOT NULL',
      date: 'TEXT NOT NULL',
      exception_type: 'INTEGER NOT NULL'
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_calendar_dates_service ON calendar_dates(service_id)',
      'CREATE INDEX IF NOT EXISTS idx_calendar_dates_date ON calendar_dates(date)'
    ]
  },
  feed_info: {
    file: 'feed_info.txt',
    columns: {
      feed_publisher_name: 'TEXT',
      feed_publisher_url: 'TEXT',
      feed_lang: 'TEXT',
      feed_start_date: 'TEXT',
      feed_end_date: 'TEXT',
      feed_version: 'TEXT',
      feed_id: 'TEXT'
    },
    indexes: []
  },
  transfers: {
    file: 'transfers.txt',
    columns: {
      from_stop_id: 'TEXT NOT NULL',
      to_stop_id: 'TEXT NOT NULL',
      transfer_type: 'INTEGER NOT NULL',
      min_transfer_time: 'INTEGER',
      from_trip_id: 'TEXT',
      to_trip_id: 'TEXT'
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_stop_id)',
      'CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_stop_id)'
    ]
  }
};

/**
 * Parst eine CSV-Zeile unter Berücksichtigung von Anführungszeichen
 */
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Importiert eine einzelne GTFS-Datei in die SQLite-DB
 */
async function importTable(db, tableName, tableDef, gtfsDir) {
  const filePath = path.join(gtfsDir, tableDef.file);

  if (!fs.existsSync(filePath)) {
    console.log(`  Überspringe ${tableName} (${tableDef.file} nicht vorhanden)`);
    return 0;
  }

  // Datei zeilenweise lesen
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  let headerRow = null;
  let columnMapping = null;
  let insertStmt = null;
  let rowCount = 0;
  const batchSize = 10000;
  let batch = [];

  for await (const line of rl) {
    if (line.trim() === '') continue;

    // BOM entfernen (UTF-8 BOM am Dateianfang)
    const cleanLine = line.replace(/^\uFEFF/, '');

    if (!headerRow) {
      // Erste Zeile = Header
      headerRow = parseCSVLine(cleanLine).map(h => h.toLowerCase().trim());

      // Nur Spalten importieren, die in der Tabellendefinition existieren
      const knownColumns = Object.keys(tableDef.columns);
      columnMapping = headerRow
        .map((col, idx) => ({ name: col, idx }))
        .filter(c => knownColumns.includes(c.name));

      if (columnMapping.length === 0) {
        console.log(`  Überspringe ${tableName} (keine passenden Spalten gefunden)`);
        return 0;
      }

      // Tabelle erstellen
      const colDefs = columnMapping.map(c => `${c.name} ${tableDef.columns[c.name]}`).join(', ');
      db.exec(`DROP TABLE IF EXISTS ${tableName}`);
      db.exec(`CREATE TABLE ${tableName} (${colDefs})`);

      // Prepared Statement
      const placeholders = columnMapping.map(() => '?').join(', ');
      const colNames = columnMapping.map(c => c.name).join(', ');
      insertStmt = db.prepare(`INSERT OR IGNORE INTO ${tableName} (${colNames}) VALUES (${placeholders})`);

      continue;
    }

    const fields = parseCSVLine(cleanLine);
    const values = columnMapping.map(c => {
      const val = fields[c.idx];
      if (val === undefined || val === '') return null;
      return val;
    });

    batch.push(values);

    if (batch.length >= batchSize) {
      const tx = db.transaction((rows) => {
        for (const row of rows) insertStmt.run(...row);
      });
      tx(batch);
      rowCount += batch.length;
      batch = [];
      process.stdout.write(`\r  ${tableName}: ${rowCount.toLocaleString()} Zeilen...`);
    }
  }

  // Restliche Zeilen einfügen
  if (batch.length > 0) {
    const tx = db.transaction((rows) => {
      for (const row of rows) insertStmt.run(...row);
    });
    tx(batch);
    rowCount += batch.length;
  }

  // Indexe erstellen
  for (const idx of tableDef.indexes) {
    db.exec(idx);
  }

  process.stdout.write(`\r  ${tableName}: ${rowCount.toLocaleString()} Zeilen importiert\n`);
  return rowCount;
}

/**
 * Hauptfunktion: Importiert alle GTFS-Dateien in SQLite
 */
async function importGTFS(dbPath = DB_PATH, gtfsDir = GTFS_DIR) {
  // Prüfen ob GTFS-Dateien vorhanden
  if (!fs.existsSync(gtfsDir)) {
    throw new Error(`GTFS-Verzeichnis nicht gefunden: ${gtfsDir}`);
  }

  const hasFiles = Object.values(GTFS_TABLES).some(t =>
    fs.existsSync(path.join(gtfsDir, t.file))
  );
  if (!hasFiles) {
    throw new Error(`Keine GTFS-Dateien in ${gtfsDir} gefunden. Zuerst 'npm run download' ausführen.`);
  }

  // Bestehende DB löschen
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  console.log(`Erstelle SQLite-Datenbank: ${dbPath}`);
  const db = new Database(dbPath);

  // Optimierungen für schnelleren Import
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -64000'); // 64MB Cache
  db.pragma('temp_store = MEMORY');

  let totalRows = 0;
  const startTime = Date.now();

  for (const [tableName, tableDef] of Object.entries(GTFS_TABLES)) {
    const count = await importTable(db, tableName, tableDef, gtfsDir);
    totalRows += count;
  }

  // Datenbankstatistiken speichern
  db.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)`);
  const meta = db.prepare('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)');
  meta.run('imported_at', new Date().toISOString());
  meta.run('total_rows', totalRows.toString());
  meta.run('source_dir', gtfsDir);

  // Status aus gtfs-status.json laden falls vorhanden
  const statusFile = path.join(gtfsDir, 'gtfs-status.json');
  if (fs.existsSync(statusFile)) {
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    meta.run('gtfs_filename', status.filename || '');
    meta.run('gtfs_url', status.url || '');
    meta.run('gtfs_downloaded_at', status.downloaded_at || '');
  }

  // Optimierungen zurücksetzen
  db.pragma('synchronous = NORMAL');

  // ANALYZE für Abfrageoptimierung
  db.exec('ANALYZE');

  db.close();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const dbSize = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1);
  console.log(`\nImport abgeschlossen:`);
  console.log(`  ${totalRows.toLocaleString()} Zeilen in ${elapsed}s`);
  console.log(`  Datenbankgrösse: ${dbSize} MB`);

  return { totalRows, elapsed, dbSize, dbPath };
}

// Exportieren für Tests und andere Module
module.exports = { importGTFS, GTFS_TABLES, DB_PATH, GTFS_DIR, parseCSVLine };

// Hauptablauf (nur wenn direkt ausgeführt)
if (require.main === module) {
  importGTFS().catch(err => {
    console.error('FEHLER:', err.message || err);
    process.exit(1);
  });
}
