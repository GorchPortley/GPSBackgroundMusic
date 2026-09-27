/**
 * Generate a self-signed certificate so the app can be served over HTTPS on
 * the local network.
 *
 * Phones refuse to hand over location to a plain http:// LAN address —
 * geolocation requires a secure context, and only `localhost` gets a free pass.
 * A self-signed cert is enough: once you tap through the browser warning the
 * origin counts as secure and location works.
 *
 * The certificate lists every LAN address this machine currently has, so the
 * same file works whichever interface you connect over.
 *
 *   npm run cert
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lanAddresses } from '../server/net.js';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const CERT_DIR = join(ROOT, 'certs');
const KEY_PATH = join(CERT_DIR, 'key.pem');
const CERT_PATH = join(CERT_DIR, 'cert.pem');

/** Safari rejects self-signed certs valid for much longer than this. */
const DAYS = 397;

function main() {
  const force = process.argv.includes('--force');
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH) && !force) {
    console.log('Certificate already exists at certs/. Re-run with --force to replace it.');
    return;
  }

  const addresses = lanAddresses();
  const sans = [
    'DNS:localhost',
    'IP:127.0.0.1',
    ...addresses.map((a) => `IP:${a.address}`),
  ];

  mkdirSync(CERT_DIR, { recursive: true });

  try {
    execFileSync('openssl', [
      'req', '-x509',
      '-newkey', 'rsa:2048',
      '-nodes',
      '-keyout', KEY_PATH,
      '-out', CERT_PATH,
      '-days', String(DAYS),
      '-subj', '/CN=GPS Background Music',
      '-addext', `subjectAltName=${sans.join(',')}`,
      '-addext', 'basicConstraints=CA:FALSE',
      '-addext', 'keyUsage=digitalSignature,keyEncipherment',
      '-addext', 'extendedKeyUsage=serverAuth',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    // Leave no half-written pair behind for the server to trip over.
    rmSync(KEY_PATH, { force: true });
    rmSync(CERT_PATH, { force: true });

    const stderr = err.stderr?.toString?.().trim();
    console.error('\nCould not generate a certificate.\n');
    if (err.code === 'ENOENT') {
      console.error('  openssl was not found on your PATH.');
      console.error('  On Windows it ships with Git: C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe');
      console.error('  Either add that to PATH, or run this script from Git Bash.\n');
    } else if (stderr) {
      console.error(`  openssl said: ${stderr}\n`);
    }
    process.exitCode = 1;
    return;
  }

  writeFileSync(join(CERT_DIR, '.gitignore'), '*\n');

  console.log('\n  Certificate written to certs/ (valid for %d days).', DAYS);
  console.log('  Covers: localhost, 127.0.0.1%s',
    addresses.length ? `, ${addresses.map((a) => a.address).join(', ')}` : '');
  console.log('\n  Now run:  npm start\n');
  console.log('  Your phone will warn that the certificate is not trusted —');
  console.log('  that is expected for a self-signed cert. Tap through it');
  console.log('  (Advanced -> Proceed on Android, Show Details -> visit on iOS)');
  console.log('  and location will work.\n');
}

main();
