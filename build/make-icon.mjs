// Renders build/icon.svg to build/icon.ico (PNG-in-ICO, 16 to 256 px) with the Chrome that Playwright drives.
// Run after changing the mark: node build/make-icon.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const svg = fs.readFileSync(new URL('./icon.svg', import.meta.url), 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
const pngs = [];
for (const s of sizes) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${s}px;height:${s}px}</style>${svg}`);
  pngs.push(await page.screenshot({ omitBackground: true }));
}
await browser.close();
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  head[e] = s % 256; head[e + 1] = s % 256; // 0 means 256
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.writeFileSync(new URL('./icon.ico', import.meta.url), Buffer.concat([head, ...pngs]));
console.log('build/icon.ico', offset, 'bytes');
