// Desktop shell: the Electron window shows the course list from a first-run projects folder, stays on the local
// origin, and a second launch exits without opening another window.
import { test, expect, _electron as electron } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

test('desktop app: first run lists the demo courses; a second launch keeps one window', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-desktop-')), 'projects');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-userdata-'));
  const args = ['.', '--root', root, `--user-data-dir=${userData}`];
  const app = await electron.launch({ args });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Lab Safety Essentials').first()).toBeVisible();
    expect(new URL(page.url()).hostname).toBe('127.0.0.1');
    expect(fs.existsSync(path.join(root, 'lab-safety.course.json'))).toBe(true);
    const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    expect([prefs.contextIsolation, prefs.sandbox, prefs.nodeIntegration]).toEqual([true, true, false]);

    const second = spawnSync(electronPath, args, { timeout: 20000 }); // the lock is held: this instance quits at once
    expect(second.status).toBe(0);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await app.close();
  }
});
