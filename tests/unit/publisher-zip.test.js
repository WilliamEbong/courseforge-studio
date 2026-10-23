import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { zipDir, writeZip } from '../../packages/publisher/zip.js';

const FILES = {
  'index.html': '<!doctype html><title>x</title>' + 'hello '.repeat(200),
  'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  'assets/deep/data.json': JSON.stringify({ a: 'b'.repeat(500) }),
  'empty.txt': '',
  'café/naïve.txt': 'utf-8 name',
};

const temps = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-zip-')); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function makeTree() {
  const dir = tmp();
  for (const [rel, body] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

// Extract with a tool that is not ours. Returns {name: Buffer} or null when no tool is available.
const PY = `import sys, zipfile, json, base64
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({i.filename: [base64.b64encode(z.read(i)).decode(), i.compress_type] for i in z.infolist()}))`;
function independentRead(zipFile) {
  const py = spawnSync('python', ['-I', '-c', PY, zipFile], { encoding: 'utf8' });
  if (py.status === 0) {
    const out = JSON.parse(py.stdout);
    return { tool: 'python', files: Object.fromEntries(Object.entries(out).map(([k, [b64, m]]) => [k, { data: Buffer.from(b64, 'base64'), method: m }])) };
  }
  if (!py.error) assert.fail(`python zipfile rejected the archive: ${py.stderr}`);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar';
  const out = tmp();
  const r = spawnSync(tar, ['-xf', zipFile, '-C', out], { encoding: 'utf8' });
  if (r.error) return null;
  assert.equal(r.status, 0, r.stderr);
  const files = {};
  for (const rel of fs.readdirSync(out, { recursive: true })) {
    const full = path.join(out, rel);
    if (fs.statSync(full).isFile()) files[rel.split(path.sep).join('/')] = { data: fs.readFileSync(full) };
  }
  return { tool: 'tar', files };
}

test('independent tool extracts identical content', (t) => {
  const dir = makeTree();
  const out = path.join(tmp(), 'pkg.zip');
  writeZip(dir, out);
  const got = independentRead(out);
  if (!got) { t.skip('no python or tar available'); return; }
  assert.deepEqual(Object.keys(got.files).sort(), Object.keys(FILES).sort());
  for (const [rel, body] of Object.entries(FILES)) assert.deepEqual(got.files[rel].data, Buffer.from(body), rel);
  if (got.tool === 'python') {
    assert.equal(got.files['index.html'].method, 8, 'text is deflated');
    assert.equal(got.files['assets/logo.png'].method, 0, 'png is stored');
    assert.equal(got.files['empty.txt'].method, 0, 'empty file is stored');
  }
});

test('deterministic: same tree gives same bytes regardless of mtime and creation order', () => {
  const a = makeTree();
  const first = zipDir(a);
  fs.utimesSync(path.join(a, 'index.html'), new Date(2030, 0, 1), new Date(2030, 0, 1));
  assert.deepEqual(zipDir(a), first);
  // A second tree written in reverse order yields the same archive.
  const b = tmp();
  for (const [rel, body] of Object.entries(FILES).reverse()) {
    fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true });
    fs.writeFileSync(path.join(b, rel), body);
  }
  assert.deepEqual(zipDir(b), first);
});

test('header fields: fixed 1980-01-01 timestamp, UTF-8 flag, sorted names', () => {
  const buf = zipDir(makeTree());
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    assert.equal(buf.readUInt16LE(p + 8) & 0x0800, 0x0800);
    assert.equal(buf.readUInt16LE(p + 12), 0); // time
    assert.equal(buf.readUInt16LE(p + 14), 0x21); // date 1980-01-01
    const n = buf.readUInt16LE(p + 28);
    names.push(buf.toString('utf8', p + 46, p + 46 + n));
    p += 46 + n;
  }
  assert.deepEqual(names, ['assets/deep/data.json', 'assets/logo.png', 'café/naïve.txt', 'empty.txt', 'index.html']);
});

test('empty directory gives a valid empty archive', () => {
  const buf = zipDir(tmp());
  assert.equal(buf.length, 22);
  assert.equal(buf.readUInt32LE(0), 0x06054b50);
});
