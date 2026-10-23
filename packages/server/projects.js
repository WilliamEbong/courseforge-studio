// The user's projects folder: Documents/CourseForge Studio, created on first run with the original samples.
// Shared by `cf app` and the desktop shell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../samples');

/** Windows may move Documents (for example into a synced folder): ask the shell; elsewhere ~/Documents. */
export function documentsDir() {
  const win = process.platform === 'win32' && spawnSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
  return win || path.join(os.homedir(), 'Documents');
}

/** Create `root` with the two sample courses and their assets when it does not exist yet. Returns true on first run. */
export function ensureProjects(root) {
  if (fs.existsSync(root)) return false;
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  for (const f of ['lab-safety.course.json', 'lab-basics-lessons.course.json']) fs.copyFileSync(path.join(SAMPLES, f), path.join(root, f));
  for (const f of fs.readdirSync(path.join(SAMPLES, 'assets'))) fs.copyFileSync(path.join(SAMPLES, 'assets', f), path.join(root, 'assets', f));
  return true;
}
