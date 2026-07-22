const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const unzipper = require('unzipper');
const cheerio = require('cheerio');

// URL der Übersichtsseite mit allen GTFS-Downloads
const GTFS_PAGE = 'https://data.opentransportdata.swiss/de/dataset/timetable-2026-gtfs2020';
// Zielverzeichnis für die entpackten GTFS-Dateien
const TARGET_DIR = path.join(__dirname, 'zvv-data', 'gtfs');

// Timeout für HTTP-Requests (30 Sekunden)
const REQUEST_TIMEOUT = 30000;
// Timeout für Downloads (5 Minuten)
const DOWNLOAD_TIMEOUT = 300000;

// Liste der erwarteten GTFS-Dateien
const REQUIRED_GTFS_FILES = [
  'agency.txt',
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'feed_info.txt',
  'transfers.txt'
];

// Exportieren für Tests
module.exports = {
  GTFS_PAGE,
  TARGET_DIR,
  REQUIRED_GTFS_FILES,
  areGtfsFilesPresent,
  fetchLatestZipUrl,
  isValidZipHeader,
  downloadAndExtractZip
};

/**
 * Prüft, ob alle erforderlichen GTFS-Dateien bereits vorhanden sind
 */
function areGtfsFilesPresent() {
  if (!fs.existsSync(TARGET_DIR)) {
    return false;
  }

  const missing = [];
  for (const file of REQUIRED_GTFS_FILES) {
    const filePath = path.join(TARGET_DIR, file);
    if (!fs.existsSync(filePath)) {
      missing.push(file);
    }
  }

  if (missing.length > 0) {
    console.log(`Fehlende GTFS-Dateien: ${missing.join(', ')}`);
    return false;
  }

  return true;
}

/**
 * Prüft, ob die Datei einen gültigen ZIP-Header besitzt (0x504b0304)
 */
function isValidZipHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(4);
  fs.readSync(fd, buffer, 0, 4, 0);
  fs.closeSync(fd);
  return buffer.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}

/**
 * HTTP(S) GET mit Timeout
 */
function httpGet(url, timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'mcp-gtfs/2.0 (Node.js GTFS-Downloader)' } }, resolve);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Timeout nach ${timeout}ms für ${url}`));
    });
    req.on('error', reject);
  });
}

/**
 * Holt die Übersichtsseite, sucht alle Download-Links zu ZIP-Dateien,
 * sortiert sie nach Datum im Dateinamen (absteigend) und gibt den neuesten zurück.
 */
async function fetchLatestZipUrl() {
  const res = await httpGet(GTFS_PAGE);
  const data = await new Promise((resolve, reject) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => resolve(body));
    res.on('error', reject);
  });

  const $ = cheerio.load(data);
  const links = [];

  $('a').each((i, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('/download/') && href.endsWith('.zip')) {
      links.push(href.startsWith('http') ? href : 'https://data.opentransportdata.swiss' + href);
    }
  });

  if (links.length === 0) {
    throw new Error('Kein gültiger GTFS-Download-Link gefunden!');
  }

  // Unterstützt beide Datumsformate: 2025-05-22 und 20251211
  links.sort((a, b) => {
    const extractDate = (url) => {
      const dashMatch = url.match(/(\d{4}-\d{2}-\d{2})/);
      if (dashMatch) return dashMatch[1].replace(/-/g, '');
      const compactMatch = url.match(/(\d{4})(\d{2})(\d{2})\.zip/);
      if (compactMatch) return compactMatch[1] + compactMatch[2] + compactMatch[3];
      return '00000000';
    };
    return extractDate(b).localeCompare(extractDate(a));
  });

  return links[0];
}

/**
 * Lädt eine Datei herunter, folgt Redirects (max 5)
 */
function downloadWithRedirect(url, destStream, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Zu viele Redirects beim Download!'));

    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: { 'User-Agent': 'mcp-gtfs/2.0 (Node.js GTFS-Downloader)' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        console.log(`  Redirect -> ${redirectUrl}`);
        downloadWithRedirect(redirectUrl, destStream, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download fehlgeschlagen: HTTP ${res.statusCode}`));
      }

      const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const pct = Math.round((downloadedBytes / totalBytes) * 100);
          process.stdout.write(`\r  Download: ${pct}% (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB)`);
        }
      });

      res.pipe(destStream);
      destStream.on('finish', () => {
        if (totalBytes > 0) process.stdout.write('\n');
        resolve();
      });
    });

    req.setTimeout(DOWNLOAD_TIMEOUT, () => {
      req.destroy();
      reject(new Error(`Download-Timeout nach ${DOWNLOAD_TIMEOUT}ms`));
    });
    req.on('error', reject);
  });
}

/**
 * Lädt ZIP herunter, validiert, entpackt und räumt auf
 */
async function downloadAndExtractZip(zipUrl, targetDir = TARGET_DIR) {
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const tmpZip = path.join(targetDir, 'gtfs-latest.zip');
  const file = fs.createWriteStream(tmpZip);

  console.log(`Starte Download: ${zipUrl}`);
  await downloadWithRedirect(zipUrl, file);

  // ZIP-Header validieren
  if (!isValidZipHeader(tmpZip)) {
    const text = fs.readFileSync(tmpZip, 'utf8').slice(0, 500);
    fs.unlinkSync(tmpZip);
    throw new Error(`Heruntergeladene Datei ist keine gültige ZIP! Inhalt:\n${text}`);
  }

  // Entpacken
  console.log('  Entpacke...');
  await new Promise((resolve, reject) => {
    fs.createReadStream(tmpZip)
      .pipe(unzipper.Extract({ path: targetDir }))
      .on('close', resolve)
      .on('error', (err) => {
        fs.unlinkSync(tmpZip);
        reject(new Error('Fehler beim Entpacken: ' + err.message));
      });
  });

  // Status-Datei schreiben
  const filename = path.basename(zipUrl.split('?')[0]);
  const status = {
    filename,
    url: zipUrl,
    downloaded_at: new Date().toISOString(),
    unpacked_to: targetDir,
    source_page: GTFS_PAGE
  };
  fs.writeFileSync(path.join(targetDir, 'gtfs-status.json'), JSON.stringify(status, null, 2), 'utf8');

  // Aufräumen
  fs.unlinkSync(tmpZip);
  console.log(`  Fertig! ${REQUIRED_GTFS_FILES.length} GTFS-Dateien entpackt.`);
}

// Hauptablauf (nur wenn direkt ausgeführt)
if (require.main === module) {
  (async () => {
    try {
      if (areGtfsFilesPresent()) {
        console.log('Alle GTFS-Dateien sind bereits vorhanden. Überspringe Download.');
        process.exit(0);
      }

      console.log('Suche nach dem neuesten GTFS-ZIP...');
      const zipUrl = await fetchLatestZipUrl();
      console.log(`Gefunden: ${zipUrl}`);
      await downloadAndExtractZip(zipUrl);
      console.log('GTFS-Download abgeschlossen.');
    } catch (err) {
      console.error('FEHLER:', err.message || err);
      process.exit(1);
    }
  })();
}
