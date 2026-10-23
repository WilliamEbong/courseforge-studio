// Local static server (127.0.0.1 only) for published packages plus the mock-LMS harness.
// Usage: node packages/lms-test-harness/serve.js <packageDir> [port]
//   http://127.0.0.1:<port>/            -> files from <packageDir>
//   http://127.0.0.1:<port>/__lms/      -> SCORM 1.2 mock LMS that launches the package's manifest entry point
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.xml': 'application/xml', '.xsd': 'application/xml', '.dtd': 'application/xml-dtd', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.vtt': 'text/vtt', '.woff': 'font/woff',
  '.webm': 'video/webm', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon', '.txt': 'text/plain',
};
const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));

// Resolve a URL path inside root; returns null when it escapes root (path traversal guard).
export function resolveInside(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const full = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

export function createServer(packageDir, { log = () => {} } = {}) {
  const root = path.resolve(packageDir);
  return http.createServer((req, res) => {
    // ponytail: GET only; the harness keeps its call log client-side.
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const url = new URL(req.url, 'http://x');
    let base = root, p = url.pathname;
    if (p.startsWith('/__lms/')) { base = HARNESS_DIR; p = p.slice('/__lms'.length); }
    let file = resolveInside(base, p);
    if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file || !fs.existsSync(file)) { log(`404 ${req.url}`); res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
    log(`200 ${req.url}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, port = '8411'] = process.argv.slice(2);
  if (!dir) { console.error('usage: node serve.js <packageDir> [port]'); process.exit(2); }
  createServer(dir, { log: (m) => console.log(m) }).listen(Number(port), '127.0.0.1', () =>
    console.log(`serving ${path.resolve(dir)} at http://127.0.0.1:${port}/  (mock LMS: /__lms/)`));
}
