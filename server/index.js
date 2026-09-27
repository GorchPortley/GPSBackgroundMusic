/**
 * Static file server + thin Google Places proxy.
 *
 * The proxy exists so the Maps API key stays on this machine instead of being
 * shipped to every browser, and so repeated lookups along a route hit an
 * in-memory cache rather than billed requests.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNearbyPlaces, providerName } from './places.js';
import { geocode } from './osm.js';
import { lanAddresses } from './net.js';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const CERT_DIR = join(ROOT, 'certs');
const PORT = Number(process.env.PORT || 8787);
const RADIUS = clamp(Number(process.env.PLACES_RADIUS || 350), 50, 5000);

/**
 * DEV_TOOLS=1 serves tools/*.js at /tools/… and examples/*.json at
 * /examples/…, so the verification harnesses never have to be copied into
 * public/ (and from there into the APK). Off by default.
 */
const DEV_TOOLS = process.env.DEV_TOOLS === '1';
const TOOLS_DIR = join(ROOT, 'tools');
const EXAMPLES_DIR = join(ROOT, 'examples');

/**
 * Set HTTPS=0 to force plain HTTP even when a certificate exists. Needed when
 * something else terminates TLS in front of this server — `tailscale serve`,
 * a tunnel, a reverse proxy — since those expect a plain HTTP backend.
 */
const HTTPS_DISABLED = /^(0|false|no|off)$/i.test(String(process.env.HTTPS ?? ''));

/**
 * Phones will not give up their location over plain http:// to anything but
 * localhost, so serve HTTPS whenever a certificate is available.
 * `npm run cert` creates one.
 */
function loadCertificate() {
  if (HTTPS_DISABLED) return null;
  return loadCertificateFiles();
}

function loadCertificateFiles() {
  try {
    return {
      key: readFileSync(join(CERT_DIR, 'key.pem')),
      cert: readFileSync(join(CERT_DIR, 'cert.pem')),
    };
  } catch {
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const handler = async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJSON(res, 400, { error: 'Bad request URL' });
  }

  try {
    if (url.pathname === '/api/config') return handleConfig(res);
    if (url.pathname === '/api/places') return await handlePlaces(url, res);
    if (url.pathname === '/api/geocode') return await handleGeocode(url, res);
    if (DEV_TOOLS && url.pathname.startsWith('/tools/')) {
      return await serveDevFile(TOOLS_DIR, url.pathname.slice('/tools/'.length), '.js', res);
    }
    if (DEV_TOOLS && url.pathname.startsWith('/examples/')) {
      return await serveDevFile(EXAMPLES_DIR, url.pathname.slice('/examples/'.length), '.json', res);
    }
    return await serveStatic(url.pathname, res);
  } catch (err) {
    console.error(`[error] ${url.pathname}:`, err);
    return sendJSON(res, 500, { error: err.message });
  }
};

const credentials = loadCertificate();
const scheme = credentials ? 'https' : 'http';
const server = credentials
  ? createHttpsServer(credentials, handler)
  : createHttpServer(handler);

// No host argument: Node binds every interface, IPv4 and IPv6 both, so the
// phone on your Wi-Fi can reach it and `localhost` (which resolves to ::1 on
// Windows) still works here.
server.listen(PORT, () => {
  const provider = providerName();
  const lan = lanAddresses();

  console.log(`\n  GPS Background Music`);
  console.log(`  ${'-'.repeat(52)}`);
  console.log(`  On this machine   ${scheme}://localhost:${PORT}`);

  if (lan.length) {
    console.log(`  On your phone     ${scheme}://${lan[0].address}:${PORT}`);
    for (const { address, name } of lan.slice(1)) {
      console.log(`                    ${scheme}://${address}:${PORT}   (${name})`);
    }
  }

  console.log(`  ${'-'.repeat(52)}`);
  const providerNote = {
    osm: '   (OpenStreetMap, no key needed)',
    mock: '   (generated data; set PLACES_PROVIDER=osm for real places)',
    google: '   (Places API New)',
  }[provider] || '';
  console.log(`  places provider   ${provider}${providerNote}`);
  console.log(`  search radius     ${RADIUS} m`);

  if (HTTPS_DISABLED) {
    console.log(`\n  HTTPS=0 — serving plain HTTP for a TLS terminator in front.`);
    console.log(`  Live GPS needs whatever proxies this to be https://.`);
    // Easy to set HTTPS=0 for a tunnel and then forget about it. Unused
    // certificates sitting in certs/ are the tell.
    if (loadCertificateFiles()) {
      console.log('');
      console.log(`  Note: certs/ exists but is unused because HTTPS=0 is set in .env.`);
      console.log(`  If nothing is proxying this, clear that line and restart —`);
      console.log(`  phones will not give up their location over plain http.`);
    }
  } else if (!credentials) {
    console.log(`\n  Live GPS only works on localhost over http.`);
    console.log(`  To use your phone:  npm run cert   then restart.`);
  } else {
    console.log(`\n  Serving HTTPS with a self-signed certificate. Your phone`);
    console.log(`  will warn you once — tap through it and location will work.`);
  }
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Stop the other server, or set PORT in .env.\n`);
    process.exit(1);
  }
  throw err;
});

/* ---------------------------------------------------------------- handlers */

function handleConfig(res) {
  sendJSON(res, 200, { provider: providerName(), radius: RADIUS });
}

async function handlePlaces(url, res) {
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
      Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return sendJSON(res, 400, { error: 'lat and lng are required and must be valid coordinates' });
  }

  const radius = clamp(Number(url.searchParams.get('radius')) || RADIUS, 50, 5000);
  const data = await getNearbyPlaces(lat, lng, radius);
  sendJSON(res, 200, { ...data, radius, center: { lat, lng } });
}

/** Place name -> coordinates, so you can audition anywhere without going there. */
async function handleGeocode(url, res) {
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) return sendJSON(res, 400, { error: 'q must be at least 2 characters' });
  try {
    return sendJSON(res, 200, { results: await geocode(q, 6) });
  } catch (err) {
    return sendJSON(res, 502, { error: err.message });
  }
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = resolve(join(PUBLIC_DIR, rel));

  // Refuse anything that escapes public/ via ../ or an absolute path.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  let body;
  try {
    body = await readFile(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

/**
 * DEV_TOOLS only: one file of type `ext` from `dir`, with the same traversal
 * guard as serveStatic. Anything outside `dir` or of another type is a 404.
 */
async function serveDevFile(dir, rel, ext, res) {
  let filePath;
  try {
    filePath = resolve(join(dir, decodeURIComponent(rel)));
  } catch {
    filePath = null;
  }
  if (!filePath || !filePath.startsWith(dir + sep) ||
      extname(filePath).toLowerCase() !== ext) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  let body;
  try {
    body = await readFile(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext],
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

/* ------------------------------------------------------------------ utils */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
