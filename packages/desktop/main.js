// CourseForge Studio desktop shell: the local editor server in-process, shown in one locked-down window.
// One instance only; errors go to a dialog and to <userData>/logs/main.log; updates come from GitHub Releases.
import { app, BrowserWindow, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/server.js';
import { documentsDir, ensureProjects } from '../server/projects.js';

const SMOKE = process.argv.includes('--smoke');
const argValue = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const logFile = () => path.join(app.getPath('userData'), 'logs', 'main.log');

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(' ')}\n`;
  try { fs.mkdirSync(path.dirname(logFile()), { recursive: true }); fs.appendFileSync(logFile(), line); } catch { /* the dialog still shows it */ }
  if (SMOKE) process.stderr.write(line);
}

/** Plain-language failure: what happened, what to do, where the details are. */
function fatal(what, next, err) {
  log('fatal:', what, err ?? '');
  if (SMOKE) { process.stderr.write(`smoke failed: ${what}\n`); app.exit(1); return; }
  dialog.showErrorBox('CourseForge Studio could not start', `${what}\n\n${next}\n\nDetails are in ${logFile()}`);
  app.exit(1);
}

let win = null;

function startServer(root) {
  return new Promise((resolve, reject) => {
    const server = createServer({ root, port: 0, dataDir: app.getPath('userData') });
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function openWindow(origin, token) {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640, show: false, title: 'CourseForge Studio',
    icon: path.join(app.getAppPath(), 'build', 'icon.ico'), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Every window, popups included (the preview opens in one), stays on the local origin; web links go to the browser.
  const local = (url) => url.startsWith(origin + '/');
  const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  const lock = (contents) => {
    contents.setWindowOpenHandler(({ url }) => (local(url) ? { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } } } : (external(url), { action: 'deny' })));
    contents.on('will-navigate', (e, url) => { if (!local(url)) { e.preventDefault(); external(url); } });
  };
  app.on('web-contents-created', (_e, contents) => lock(contents));
  lock(win.webContents);
  win.webContents.on('render-process-gone', (_e, d) => log('renderer gone:', d.reason));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.loadURL(`${origin}/?token=${token}`);
}

async function smoke(origin, token) {
  const r = await fetch(`${origin}/api/courses`, { headers: { 'x-cf-token': token } });
  const j = await r.json();
  if (!r.ok || !j.ok || !j.courses.some((c) => /lab-safety/.test(c.file ?? c))) throw new Error(`unexpected /api/courses reply: ${JSON.stringify(j).slice(0, 300)}`);
  process.stdout.write(`smoke ok node ${process.versions.node} electron ${process.versions.electron}\n`);
}

async function checkForUpdates() {
  if (!app.isPackaged || SMOKE) return;
  try {
    const { default: updater } = await import('electron-updater');
    const { autoUpdater } = updater;
    autoUpdater.logger = { info: (m) => log('update:', m), warn: (m) => log('update warn:', m), error: (m) => log('update error:', m), debug: () => {} };
    autoUpdater.on('update-downloaded', async (info) => {
      const { response } = await dialog.showMessageBox(win ?? undefined, {
        type: 'info', buttons: ['Restart to update', 'Later'], defaultId: 0, cancelId: 1,
        title: 'Update ready', message: `CourseForge Studio ${info.version} is ready to install.`, detail: 'Your courses are not changed. The update installs when the app restarts.',
      });
      if (response === 0) autoUpdater.quitAndInstall();
    });
    await autoUpdater.checkForUpdates();
  } catch (e) { log('update check failed:', e); } // offline or no release yet: never blocks use
}

if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  process.on('uncaughtException', (e) => log('uncaught:', e));
  app.whenReady().then(async () => {
    const root = path.resolve(argValue('--root') ?? path.join(documentsDir(), 'CourseForge Studio'));
    try { ensureProjects(root); } catch (e) { return fatal(`The projects folder ${root} could not be created.`, 'Check that your Documents folder can be written to, then open CourseForge Studio again.', e); }
    let server;
    try { server = await startServer(root); } catch (e) { return fatal('The editor could not start its local service.', 'Close CourseForge Studio everywhere and open it again. If it keeps happening, restart Windows.', e); }
    const origin = `http://127.0.0.1:${server.address().port}`;
    log('started', origin, 'root', root, 'version', app.getVersion());
    if (SMOKE) {
      try { await smoke(origin, server.token); app.exit(0); } catch (e) { fatal('The smoke check failed.', '', e); }
      return;
    }
    openWindow(origin, server.token);
    checkForUpdates();
  });
}
