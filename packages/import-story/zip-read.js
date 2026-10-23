// Minimal read-only ZIP reader for .story packages (Node stdlib)..
// Central directory only; stored (0) and deflate (8). Refuses encryption, ZIP64, multi-disk, unsafe or duplicate
// names, and archives whose declared uncompressed total or entry count exceeds the limits (zip bombs).
import zlib from 'node:zlib';

export const LIMITS = Object.freeze({ maxEntries: 20000, maxTotal: 200 * 1024 * 1024 });
const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50, Z64_LOCATOR = 0x07064b50;
const bad = (msg) => new Error(`zip: ${msg}`);

/** A safe archive path: relative, forward slashes, no `..`, no drive letter, no control characters. */
export const safeName = (n) => n.length > 0 && !/[\\:\0-\x1f]/.test(n) && !n.startsWith('/') && !n.split('/').includes('..');

/** Parse the central directory of `buf`. Returns {names, has(name), read(name) -> Buffer}. Throws Error('zip: ...'). */
export function readZip(buf, { maxEntries = LIMITS.maxEntries, maxTotal = LIMITS.maxTotal } = {}) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('zip: expected a Buffer');
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === EOCD) { e = i; break; }
  if (e < 0) throw bad('not a ZIP file (no end-of-central-directory record)');
  if (e >= 20 && buf.readUInt32LE(e - 20) === Z64_LOCATOR) throw bad('ZIP64 archives are not supported');
  if (buf.readUInt16LE(e + 4) !== 0 || buf.readUInt16LE(e + 6) !== 0) throw bad('multi-disk archives are not supported');
  const count = buf.readUInt16LE(e + 10), cdSize = buf.readUInt32LE(e + 12), cdOff = buf.readUInt32LE(e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw bad('ZIP64 archives are not supported');
  if (count > maxEntries) throw bad(`${count} entries exceed the limit of ${maxEntries}`);
  if (cdOff + cdSize > e) throw bad('central directory is out of bounds');

  const entries = new Map();
  let total = 0;
  for (let i = 0, p = cdOff; i < count; i++) {
    if (p + 46 > e || buf.readUInt32LE(p) !== CEN) throw bad(`corrupt central directory at entry ${i}`);
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24), off = buf.readUInt32LE(p + 42);
    const nlen = buf.readUInt16LE(p + 28), next = p + 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (next > e) throw bad(`corrupt central directory at entry ${i}`);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen); // OPC part names are ASCII
    const cen = buf.subarray(p, next);
    p = next;
    if (flags & 1) throw bad(`encrypted entry ${JSON.stringify(name)} is not supported`);
    if (csize === 0xffffffff || size === 0xffffffff || off === 0xffffffff) throw bad('ZIP64 archives are not supported');
    if (!safeName(name)) throw bad(`unsafe entry name ${JSON.stringify(name)}`);
    if (entries.has(name)) throw bad(`duplicate entry name ${JSON.stringify(name)}`);
    total += size;
    if (total > maxTotal) throw bad(`declared uncompressed size exceeds the limit of ${maxTotal} bytes`);
    entries.set(name, { method, crc, csize, size, off, cen });
  }
  let ends; // local-header offset -> start of the next entry (or of the central directory)
  /* * an entry's raw bytes: seg = local header .. next entry (data descriptor and any gap kept), cen = its central record. */
  function raw(name) {
    const en = entries.get(name);
    if (!en) throw bad(`no entry ${JSON.stringify(name)}`);
    if (!ends) { const offs = [...entries.values()].map((x) => x.off).sort((a, b) => a - b); ends = new Map(offs.map((o, i) => [o, offs[i + 1] ?? cdOff])); }
    return { seg: buf.subarray(en.off, ends.get(en.off)), cen: en.cen };
  }

  function read(name) {
    const en = entries.get(name);
    if (!en) throw bad(`no entry ${JSON.stringify(name)}`);
    if (en.off + 30 > buf.length || buf.readUInt32LE(en.off) !== LOC) throw bad(`corrupt local header for ${JSON.stringify(name)}`);
    const start = en.off + 30 + buf.readUInt16LE(en.off + 26) + buf.readUInt16LE(en.off + 28);
    if (start + en.csize > buf.length) throw bad(`entry ${JSON.stringify(name)} is truncated`);
    const raw = buf.subarray(start, start + en.csize);
    let out;
    if (en.method === 0) out = raw;
    else if (en.method === 8) {
      // Capped at the declared size, which the limits above already bounded: a lying header cannot inflate more.
      try { out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, en.size) }); } catch (err) {
        throw bad(`cannot inflate ${JSON.stringify(name)}: ${err.code === 'ERR_BUFFER_TOO_LARGE' ? 'larger than its declared size' : err.message}`);
      }
    } else throw bad(`entry ${JSON.stringify(name)} uses unsupported compression method ${en.method}`);
    if (out.length !== en.size) throw bad(`entry ${JSON.stringify(name)} does not match its declared size`);
    if (zlib.crc32(out) !== en.crc) throw bad(`entry ${JSON.stringify(name)} failed its CRC check`);
    return out;
  }
  return { names: [...entries.keys()], has: (n) => entries.has(n), read, raw, eocd: buf.subarray(e) };
}
