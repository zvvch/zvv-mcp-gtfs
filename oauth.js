/**
 * OAuth 2.1 mit PKCE fuer den geschuetzten MCP-Endpunkt (/mcp-admin).
 *
 * Einzelnutzer-Setup: der PIN ist die Anmeldung, der Server ist zugleich
 * Resource Server UND Authorization Server. Deshalb ist alles ZUSTANDSLOS
 * geloest -- client_id, Authorization Code, Access- und Refresh-Token sind
 * HMAC-signierte Nutzdaten. Es gibt keinen Token-Speicher, nichts geht bei
 * einem Neustart verloren, und es kommt keine Datenbank dazu.
 *
 * Zwei Dinge, die dabei leicht schiefgehen und hier bewusst geloest sind:
 *
 * 1. TYPTRENNUNG. Session-Cookie und Access-Token werden mit demselben
 *    Secret signiert. Ohne Typkennzeichnung im signierten Nutzteil koennte
 *    ein Cookie als Access-Token durchgehen (und umgekehrt). Jeder Typ
 *    traegt deshalb ein eigenes Kuerzel, das mitsigniert wird.
 *
 * 2. EINMALVERWENDUNG DER CODES. Ein signierter Code ist fuer sich genommen
 *    beliebig oft einloesbar. Ein In-Memory-Set verhindert die zweite
 *    Einloesung; nach einem Neustart ist es leer, deshalb leben Codes nur
 *    60 Sekunden -- das Zeitfenster fuer einen Replay ist damit winzig.
 */

const crypto = require('crypto');

const CODE_TTL_MS = 60 * 1000;              // Authorization Code: sehr kurz
const ACCESS_TTL_S = 60 * 60;               // Access-Token: 1 Stunde
const REFRESH_TTL_S = 30 * 24 * 60 * 60;    // Refresh-Token: 30 Tage
const CLIENT_TTL_S = 365 * 24 * 60 * 60;    // Registrierung: 1 Jahr

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Konstantzeit-Vergleich zweier Strings */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Signiert Nutzdaten. Das Typkuerzel wandert MIT in die Signatur -- damit
 * laesst sich ein Artefakt eines Typs nicht als ein anderer ausgeben.
 */
function sign(secret, kind, payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(`${kind}.${body}`).digest('base64url');
  return `${kind}.${body}.${mac}`;
}

/** Gegenstueck zu sign(). Gibt null zurueck, wenn irgendetwas nicht stimmt. */
function verify(secret, kind, token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [k, body, mac] = parts;
  if (k !== kind) return null;                       // falscher Typ
  const expected = crypto.createHmac('sha256', secret).update(`${k}.${body}`).digest('base64url');
  if (!safeEqual(mac, expected)) return null;        // Signatur passt nicht
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.exp && Date.now() > payload.exp) return null;  // abgelaufen
  return payload;
}

/** PKCE S256: erfuellt der Verifier die Challenge? */
function pkceMatches(verifier, challenge, method) {
  if (!verifier || !challenge) return false;
  if (method === 'plain') return safeEqual(verifier, challenge);
  // S256 ist der Standard und der einzige, den wir sonst zulassen.
  const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(hash, challenge);
}

/**
 * Merkt sich eingeloeste Codes, damit sie nicht zweimal gehen.
 * Gedeckelt, damit die Menge nicht unbegrenzt waechst.
 */
function createUsedCodeStore(max = 5000) {
  const used = new Map(); // nonce -> Ablauf
  return {
    seen(nonce, expMs) {
      const now = Date.now();
      for (const [k, exp] of used) if (exp <= now) used.delete(k);
      if (used.has(nonce)) return true;
      if (used.size >= max) used.delete(used.keys().next().value);
      used.set(nonce, expMs);
      return false;
    },
  };
}

module.exports = {
  sign, verify, safeEqual, pkceMatches, createUsedCodeStore, b64u,
  CODE_TTL_MS, ACCESS_TTL_S, REFRESH_TTL_S, CLIENT_TTL_S,
};
