import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importStory } from '../../packages/import-story/index.js';
import { publishWeb } from '../../packages/publisher/index.js';
import { slide, pkg } from '../fixtures/synthetic/story-builder.js';
import { tableShape, vectorShapes } from '../fixtures/synthetic/vector-shapes.js';

test('generated native vector images load and rich table cells clip within padded cell bounds', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-vectors-e2e-'));
  try {
    const { doc } = importStory(pkg({ parts: [slide(101, { shapes: vectorShapes() + tableShape() })] }), { courseDir: dir, assetsDir: path.join(dir, 'assets') });
    publishWeb(doc, path.join(dir, 'web'), { courseDir: dir });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(dir, 'web/index.html')).href);
    await expect(page.locator('img.cf-obj')).toHaveCount(4);
    expect(await page.locator('img.cf-obj').evaluateAll(images => images.every(i => i.complete && i.naturalWidth > 0))).toBe(true);
    const cells = page.locator('.cf-text'); await expect(cells).toHaveCount(4);
    await expect(cells.first()).toHaveCSS('overflow', 'hidden');
    await expect(cells.first()).toHaveCSS('padding', '10px');
    expect(await cells.first().evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true);
    await expect(cells.nth(1)).toHaveCSS('left', '220px');
    await expect(cells.nth(2)).toHaveCSS('top', '250px');
    expect(errors).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
