/**
 * Share a pack by link (P4): `#pack=<data>`.
 *
 * <data> is the pack's compact JSON, compressed with raw DEFLATE
 * (`CompressionStream('deflate-raw')`) and base64url-encoded without padding.
 * A fragment is never sent to a server, so the link carries the pack from one
 * person to the other and nothing in between sees it.
 *
 * This module only turns packs into text and back. It never trusts what it
 * decodes: the result is a string, and the caller hands it to the same
 * `importPackText` → `sanitise()` → `validateSpec`/`validateCue` path as a
 * pasted file. No DOM here — ui.js owns that.
 */

/**
 * Longest link we will hand out, in characters. Fragments are not sent to
 * servers, so the browser's own limit (~2 MB in Chromium) never bites; what
 * does is everything the link passes through on the way: messaging apps
 * (several stop linkifying, or truncate previews, somewhere past a few KB),
 * e-mail line wrapping, and Android's shared-text intents (the binder limit is
 * ~1 MB, far above this). 8 KB holds every bundled example pack in full
 * (landmarks ≈ 5.3 KB) while staying well clear of those; past it, a file is
 * the better tool and the UI says so.
 */
export const SHARE_LINK_MAX = 8 * 1024;

/**
 * Longest payload we will even try to decode. Generous (4× what we emit) so
 * links from a future version with a higher limit still open, but small
 * enough that a pasted novel is refused before any work is done.
 */
export const SHARE_PAYLOAD_MAX = 32 * 1024;

/**
 * Hard cap on the decompressed pack. DEFLATE can expand ~1000:1, so a 300-byte
 * link could otherwise inflate to hundreds of KB (a "decompression bomb").
 * Reading stops the moment the output passes this. A real pack that fits in
 * an 8 KB link is well under 100 KB of JSON.
 */
export const SHARE_DECODED_MAX = 256 * 1024;

/** Input is fed to the decompressor in slices this size, so one read is bounded. */
const FEED_CHUNK = 512;

/**
 * Where links made inside the Android app should point. The APK serves the
 * app from https://appassets.androidplatform.net, which only exists inside
 * the app — a link to it is useless to anyone else. Set this to the public
 * URL where `public/` is hosted (README "Option 1 — a static host"), e.g.
 * 'https://example.github.io/gps-music/', before building the APK to make
 * in-app links clickable. Left empty, the app shares the bare `pack=<data>`
 * code instead, which the Paste box (and Share → GPS Music) accepts.
 * Deliberately a constant in the shipped code, not a pack field: a pack must
 * never decide where links point.
 */
export const PUBLIC_SHARE_BASE = '';

const APP_ASSETS_ORIGIN = 'https://appassets.androidplatform.net';

/** A failure with a message fit for the person, not the console. */
export class ShareError extends Error {}

/** True when this browser can both make and open pack links. */
export function shareSupported() {
  try {
    new CompressionStream('deflate-raw');
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

export const UNSUPPORTED_MESSAGE =
  'This browser cannot open or make pack links (it has no CompressionStream). ' +
  'Update it, or share the pack as a file with Export pack instead.';

/**
 * The base a link starts with, or null when the page's own address is
 * useless to others (the APK) and no public base is configured — the caller
 * then shares the bare `pack=` code.
 */
export function shareBase(loc = location) {
  if (loc.origin === APP_ASSETS_ORIGIN) return PUBLIC_SHARE_BASE || null;
  return loc.origin + loc.pathname;
}

/** Pack object → base64url(deflate-raw(JSON)). */
export async function encodePack(pack) {
  const json = JSON.stringify(pack);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return toBase64Url(bytes);
}

/**
 * Find a pack payload in whatever was pasted or opened: a full link
 * (`https://…/#pack=…`), a fragment (`#pack=…`), a bare code (`pack=…`), or
 * any of those inside a longer message. Returns the payload or null.
 */
export function extractPayload(text) {
  const m = /(?:^|[#?&\s])pack=([A-Za-z0-9_-]*={0,2})/.exec(String(text || '').trim());
  return m ? m[1] : null;
}

/**
 * base64url payload → the pack's JSON text, still untrusted. Throws
 * ShareError with a friendly message on anything wrong. The output is capped
 * at `maxBytes`: the stream is cancelled as soon as it passes that.
 */
export async function decodePayload(payload, maxBytes = SHARE_DECODED_MAX) {
  if (!payload) throw new ShareError('That link has no pack in it.');
  if (payload.length > SHARE_PAYLOAD_MAX) {
    throw new ShareError('That pack link is too long to open. Ask for the pack file instead.');
  }
  let bytes;
  try {
    bytes = fromBase64Url(payload);
  } catch {
    throw new ShareError('That pack link is damaged (not valid base64). Was it cut short when copied?');
  }

  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  // Feed in small slices. The transform's backpressure means each write waits
  // for the reader, so at most one slice's worth of output is ever buffered.
  const feed = (async () => {
    for (let i = 0; i < bytes.length; i += FEED_CHUNK) {
      await writer.write(bytes.subarray(i, i + FEED_CHUNK));
    }
    await writer.close();
  })();
  feed.catch(() => {});   // its failure also surfaces on the reader

  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});
        throw new ShareError(
          `That pack link unpacks to more than ${Math.round(maxBytes / 1024)} KB, ` +
          'which no real pack link does. It was not opened.');
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ShareError) throw err;
    throw new ShareError('That pack link is damaged (it does not decompress). Was it cut short when copied?');
  }

  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  } catch {
    throw new ShareError('That pack link is damaged (not text).');
  }
}

/**
 * What a (sanitised) pack holds, in words: for the share panel before
 * sending and for the confirm before importing. Returns
 * `{ total, lines: [{ text, warn }] }`. Names come from packs; the UI renders
 * them with textContent only.
 */
export function summarisePack(pack) {
  const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const names = (list, key) => {
    const shown = list.slice(0, 4).map((x) => String(x[key]).slice(0, 40));
    return shown.join(', ') + (list.length > 4 ? `, +${list.length - 4} more` : '');
  };
  const themes = pack.themes || [];
  const cues = pack.cues || [];
  const places = pack.locations || [];
  const tags = Object.keys(pack.tagOverrides || {}).length;
  const lines = [];
  if (themes.length) lines.push({ text: `${plural(themes.length, 'theme')}: ${names(themes, 'name')}` });
  if (cues.length) {
    lines.push({ text: `${plural(cues.length, 'cue')}: ${names(cues, 'name')}` });
    const located = cues.filter((c) => hasCoordinates(c.when, 0));
    if (located.length) {
      lines.push({
        warn: true,
        text: (located.length === cues.length
          ? (cues.length === 1 ? 'It is' : 'All are')
          : `${located.length} ${located.length === 1 ? 'is' : 'are'}`) +
          ' bound to map coordinates ' +
          `(${names(located, 'name')}) — whoever has the link can see where`,
      });
    }
  }
  if (tags) lines.push({ text: plural(tags, 'tag edit') });
  if (places.length) {
    lines.push({ warn: true, text: `${plural(places.length, 'saved place')} with exact coordinates: ${names(places, 'name')}` });
  }
  if (pack.theme) lines.push({ text: `Sets the theme to “${pack.theme}”` });
  return { total: themes.length + cues.length + places.length + tags + (pack.theme ? 1 : 0), lines };
}

/** Does a cue condition name a spot on the map (`near` or `inside`), at any depth? */
function hasCoordinates(cond, depth) {
  if (!cond || typeof cond !== 'object' || depth > 8) return false;
  if (cond.near || cond.inside) return true;
  return Array.isArray(cond.any) && cond.any.some((c) => hasCoordinates(c, depth + 1));
}

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) throw new Error('bad alphabet');
  const b64 = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (b64.length % 4 === 1) throw new Error('bad length');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
