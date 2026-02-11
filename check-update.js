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

const STATUS_FILE = path.join(__dirname, 'zvv-data', 'gtfs', 'gtfs-status.json');
const DB_PATH = path.join(__dirname, 'zvv-data', 'gtfs.db');

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
  const { checkOnly = false, force = false } = options;

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

  // Update durchfuehren
  console.log('[Update-Check] Starte Download und Import...');

  // Alte Daten entfernen
  const gtfsDir = path.join(__dirname, 'zvv-data', 'gtfs');
  const gtfsFiles = fs.readdirSync(gtfsDir).filter(f => f.endsWith('.txt'));
  for (const f of gtfsFiles) {
    fs.unlinkSync(path.join(gtfsDir, f));
  }
  // DB entfernen
  for (const ext of ['', '-wal', '-shm']) {
    const dbFile = DB_PATH + ext;
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  }

  // Download
  const { downloadAndExtractZip } = require('./download-gtfs.js');
  await downloadAndExtractZip(latestUrl);

  // Import
  const { importGTFS } = require('./import-gtfs.js');
  await importGTFS();

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
