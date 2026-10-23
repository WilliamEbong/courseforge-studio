// Deterministic ZIP writer (Node stdlib only)..
// Same file tree -> same bytes: sorted names, fixed 1980-01-01 DOS timestamp, no extra fields.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Already-compressed formats gain nothing from deflate.
const STORED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.mp4', '.m4a', '.webm', '.ogg', '.woff', '.woff2', '.zip']);
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const DOS_TIME = 0;
const UTF8_NAMES = 0x0800;
const MAX32 = 0xffffffff;

function listFiles(dir) {
  // ponytail: lstat skips symlinks so a link cannot pull files from outside dir into the package.
  return fs.readdirSync(dir, { recursive: true })
    .filter((rel) => fs.lstatSync(path.join(dir, rel)).isFile())
    .map((rel) => rel.split(path.sep).join('/'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** One fresh entry at `offset`: {local: header + name + body, cen: central record + name}. */
function record(name, data, offset) {
  const crc = zlib.crc32(data);
  // ponytail: deflate bytes depend on Node's bundled zlib; determinism holds per Node version.
  const deflated = STORED.has(path.extname(name).toLowerCase()) ? null : zlib.deflateRawSync(data);
  const method = deflated && deflated.length < data.length ? 8 : 0;
  const body = method ? deflated : data;
  const nameBuf = Buffer.from(name, 'utf8');
  if (data.length >= MAX32 || offset >= MAX32) throw new RangeError(`zip: ${name} exceeds 4 GiB limit (no ZIP64)`);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); local.writeUInt16LE(UTF8_NAMES, 6); local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(UTF8_NAMES, 8); cen.writeUInt16LE(method, 10);
  cen.writeUInt16LE(DOS_TIME, 12); cen.writeUInt16LE(DOS_DATE, 14);
  cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28); // extra, comment, disk, internal attrs, external attrs stay 0
  cen.writeUInt32LE(offset, 42);
  return { local: Buffer.concat([local, nameBuf, body]), cen: Buffer.concat([cen, nameBuf]) };
}

/** End of central directory; `base` (an existing record, comment included) keeps its other bytes. */
function eocd(count, cdSize, cdOff, base = Buffer.alloc(22)) {
  if (count > 0xffff || cdOff + cdSize >= MAX32) throw new RangeError('zip: archive exceeds ZIP limits (no ZIP64)');
  const end = Buffer.from(base);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdOff, 16);
  return end;
}

export function zipDir(dir, names = listFiles(dir)) {
  // ponytail: no ZIP64; course packages stay far below 65,535 files and 4 GiB.
  if (names.length > 0xffff) throw new RangeError(`zip: ${names.length} files exceeds 65535 (no ZIP64)`);
  const chunks = [], central = [];
  let offset = 0;
  for (const name of names) {
    const { local, cen } = record(name, fs.readFileSync(path.join(dir, name)), offset);
    chunks.push(local); central.push(cen);
    offset += local.length;
  }
  return Buffer.concat([...chunks, ...central, eocd(names.length, central.reduce((n, b) => n + b.length, 0), offset)]);
}

/**
 * rewrite an archive read by import-story/zip-read.js. Entries in `drop` go, entries in `put`
 * (Map name -> Buffer) are written fresh (new names at the end), every other entry is copied as its raw bytes
 * (local header, data, data descriptor) with only the offset in its central record patched. Same bytes when nothing changes.
 */
export function rezip(buf, zip, { put = new Map(), drop = new Set() } = {}) {
  const kept = zip.names.filter((n) => !drop.has(n));
  const fresh = [...put.keys()].filter((n) => !zip.has(n));
  const at = new Map(), cens = new Map(), chunks = [];
  let offset = 0;
  // Local order as in the file (the central record holds each original offset); central records keep their order.
  for (const name of [...kept].sort((a, b) => zip.raw(a).cen.readUInt32LE(42) - zip.raw(b).cen.readUInt32LE(42)).concat(fresh)) {
    at.set(name, offset);
    if (put.has(name)) { const r = record(name, put.get(name), offset); chunks.push(r.local); cens.set(name, r.cen); offset += r.local.length; continue; }
    const { seg, cen } = zip.raw(name);
    const c = Buffer.from(cen);
    c.writeUInt32LE(offset, 42);
    chunks.push(seg); cens.set(name, c); offset += seg.length;
  }
  const central = [...kept, ...fresh].map((n) => cens.get(n));
  return Buffer.concat([...chunks, ...central, eocd(central.length, central.reduce((n, b) => n + b.length, 0), offset, zip.eocd)]);
}

export function writeZip(dir, outFile, names) {
  fs.writeFileSync(outFile, zipDir(dir, names && [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))));
}
