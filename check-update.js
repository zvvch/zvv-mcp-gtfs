/**
 * GTFS Auto-Update Checker
 *
 * Prueft ob auf opentransportdata.swiss eine neuere GTFS-Datei verfuegbar ist.
 * Wenn ja: Download + Import + Signal zum Neustart.
 * Wenn nein: Beendet sich still.
 *
 * Verwendung:
 *   node check-update.js          # Prueft und aktualisiert bei Bedarf
 *   node check-update.js --check  # Nur pruefen, nicht aktualisieren (fuer Startup-Check)
 *   node check-update.js --force  # Erzwingt Update auch wenn Daten aktuell sind
 */

const fs = require('fs');
const path = require('path');
const { fetchLatestZipUrl, GTFS_PAGE } = require('./download-gtfs.js');

const DATA_DIR = path.join(__dirname, 'zvv-data');
const GTFS_DIR = path.join(DATA_DIR, 'gtfs');
const STATUS_FILE = path.join(GTFS_DIR, 'gtfs-status.json');
const DB_PATH = path.join(DATA_DIR, 'gtfs.db');

// Neue Daten werden erst vollstaendig danebengebaut und dann umgeschwenkt.
// So bleibt der laufende Bestand bedienbar, falls Download oder Import scheitert.
const STAGE_DIR = path.join(DATA_DIR, 'gtfs.staging');
const STAGE_DB = path.join(DATA_DIR, 'gtfs.staging.db');

const DB_SUFFIXES = ['', '-wal', '-shm'];

/** Entfernt eine SQLite-DB samt WAL- und SHM-Seitendateien */
function removeDbFiles(dbPath) {
  for (const ext of DB_SUFFIXES) {
    fs.rmSync(dbPath + ext, { force: true });
  }
}

/** Raeumt einen halbfertigen Staging-Stand weg */
function clearStaging() {
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  removeDbFiles(STAGE_DB);
}

/**
 * Schwenkt den fertigen Staging-Stand an die produktive Stelle.
 * Erst umbenennen, dann aufraeumen -- das Zeitfenster, in dem nichts
 * Vollstaendiges dasteht, ist damit auf zwei Renames begrenzt.
 */
function promoteStaging() {
  const oldDir = GTFS_DIR + '.old';
  const oldDb = DB_PATH + '.old';

  fs.rmSync(oldDir, { recursive: true, force: true });
  fs.rmSync(oldDb, { force: true });

  if (fs.existsSync(GTFS_DIR)) fs.renameSync(GTFS_DIR, oldDir);
  fs.renameSync(STAGE_DIR, GTFS_DIR);

  // WAL/SHM des alten Bestands sind nach dem Schwenk bedeutungslos.
  if (fs.existsSync(DB_PATH)) fs.renameSync(DB_PATH, oldDb);
  fs.rmSync(DB_PATH + '-wal', { force: true });
  fs.rmSync(DB_PATH + '-shm', { force: true });
  fs.renameSync(STAGE_DB, DB_PATH);

  fs.rmSync(oldDir, { recursive: true, force: true });
  fs.rmSync(oldDb, { force: true });
}

/**
 * Extrahiert das Datum aus einem GTFS-ZIP-URL oder Dateinamen
 * Unterstuetzt: gtfs_fp2026_20260209.zip und GTFS_FP2026_2025-09-22.zip
 */
function extractDateFromUrl(url) {
  if (!url) return null;
  const basename = path.basename(url.split('?')[0]);
  // Format: 20260209
  const compactMatch = basename.match(/(\d{4})(\d{2})(\d{2})\.zip$/i);
  if (compactMatch) return compactMatch[1] + compactMatch[2] + compactMatch[3];
  // Format: 2025-09-22
  const dashMatch = basename.match(/(\d{4})-(\d{2})-(\d{2})\.zip$/i);
  if (dashMatch) return dashMatch[1] + dashMatch[2] + dashMatch[3];
  return null;
}

/**
 * Liest die aktuell installierte GTFS-Version
 */
function getCurrentVersion() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
      return {
        filename: status.filename || null,
        url: status.url || null,
        date: extractDateFromUrl(status.url || status.filename),
        downloaded_at: status.downloaded_at || null
      };
    }
  } catch (e) {
    // Status-Datei nicht lesbar
  }
  return { filename: null, url: null, date: null, downloaded_at: null };
}

/**
 * Hauptfunktion: Prueft auf Updates und fuehrt sie optional durch
 */
async function checkForUpdate(options = {}) {
  const { checkOnly = false, force = false, onBeforeSwap = null } = options;

  console.log('[Update-Check] Pruefe auf neue GTFS-Daten...');
  console.log(`[Update-Check] Quelle: ${GTFS_PAGE}`);

  // Aktuellen Stand lesen
  const current = getCurrentVersion();
  if (current.filename) {
    console.log(`[Update-Check] Installiert: ${current.filename} (${current.date || 'unbekannt'})`);
  } else {
    console.log('[Update-Check] Keine GTFS-Daten installiert.');
  }

  // Neueste Version von der Website holen
  let latestUrl;
  try {
    latestUrl = await fetchLatestZipUrl();
  } catch (err) {
    console.error(`[Update-Check] Fehler beim Abrufen der Download-Seite: ${err.message}`);
    return { updateAvailable: false, error: err.message };
  }

  const latestFilename = path.basename(latestUrl.split('?')[0]);
  const latestDate = extractDateFromUrl(latestUrl);
  console.log(`[Update-Check] Verfuegbar: ${latestFilename} (${latestDate || 'unbekannt'})`);

  // Vergleichen
  const isNewer = !current.date || (latestDate && latestDate > current.date);
  const isDifferent = current.filename !== latestFilename;
  const updateAvailable = force || (isDifferent && isNewer);

  if (!updateAvailable) {
    console.log('[Update-Check] Daten sind aktuell. Kein Update noetig.');
    return { updateAvailable: false, current: current.filename, latest: latestFilename };
  }

  console.log(`[Update-Check] Neues Update verfuegbar! ${current.filename || '(keine)'} -> ${latestFilename}`);

  if (checkOnly) {
    return { updateAvailable: true, current: current.filename, latest: latestFilename, latestUrl };
  }

  // Update durchfuehren -- neben dem laufenden Bestand, nicht an seiner Stelle.
  console.log('[Update-Check] Starte Download und Import (Staging)...');

  const { downloadAndExtractZip } = require('./download-gtfs.js');
  const { importGTFS } = require('./import-gtfs.js');

  try {
    clearStaging();
    await downloadAndExtractZip(latestUrl, STAGE_DIR);
    await importGTFS(STAGE_DB, STAGE_DIR);
  } catch (err) {
    // Der bisherige Bestand ist unangetastet -- der Server laeuft weiter.
    clearStaging();
    console.error(`[Update-Check] Update fehlgeschlagen: ${err.message}`);
    console.error('[Update-Check] Bisheriger Bestand bleibt unveraendert.');
    return { updateAvailable: true, updated: false, error: err.message, current: current.filename, latest: latestFilename };
  }

  // Ab hier steht ein vollstaendiger neuer Stand bereit. Der Aufrufer
  // bekommt die Gelegenheit, offene DB-Handles zu schliessen.
  if (typeof onBeforeSwap === 'function') {
    await onBeforeSwap();
  }

  promoteStaging();

  console.log(`[Update-Check] Update abgeschlossen: ${latestFilename}`);
  return { updateAvailable: true, updated: true, current: current.filename, latest: latestFilename };
}

// Export fuer Verwendung in server.js
module.exports = { checkForUpdate, getCurrentVersion, extractDateFromUrl };

// CLI-Ausfuehrung
if (require.main === module) {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const force = args.includes('--force');

  checkForUpdate({ checkOnly, force })
    .then(result => {
      if (result.error) {
        process.exit(1);
      }
      if (result.updateAvailable && !result.updated) {
        // Update verfuegbar aber nicht ausgefuehrt (--check Modus)
        console.log(`\nUpdate verfuegbar: ${result.latest}`);
        console.log('Ausfuehren mit: node check-update.js');
        process.exit(2); // Exit-Code 2 = Update verfuegbar
      }
      process.exit(0);
    })
    .catch(err => {
      console.error('[Update-Check] Fehler:', err.message);
      process.exit(1);
    });
}
