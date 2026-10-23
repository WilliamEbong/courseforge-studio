import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importStory } from '../../packages/import-story/index.js';
import { publishWeb } from '../../packages/publisher/index.js';
import { G, ID, obj, slide, pkg, intr, choice } from '../fixtures/synthetic/story-builder.js';

let dir, url, groupUrl, largeUrl;
test.beforeAll(() => {
  const shapes = intr('multiChoiceIntr', 210, { title: G(200) })
    + obj('textBox', 200, { at: [60, 30, 660, 100], plain: 'Choose one' })
    + choice('radio', 211, 210, 'One', 150, { selected: true })
    + choice('radio', 212, 210, 'Two', 230);
  const { doc } = importStory(pkg({ parts: [slide(101, { name: 'Authored question', shapes })] }));
  doc.slides[0].question.shuffle = false;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-fidelity-e2e-'));
  publishWeb(doc, dir, { courseDir: dir });
  url = pathToFileURL(path.join(dir, 'index.html')).href;
  const large = structuredClone(doc); large.size = { w: 1920, h: 1080 };
  publishWeb(large, path.join(dir, 'large'), { courseDir: dir });
  largeUrl = pathToFileURL(path.join(dir, 'large', 'index.html')).href;
  const body = `<choices><intrFreeChoice shpG="${G(201)}" matchShpG="${G(204)}"/></choices><dragDrop onlyOne="true"/>`;
  const groupShapes = intr('dragDropIntr', 210, { body }) + obj('group', 201, { at: [20, 120, 220, 220] })
    + obj('pic', 202, { at: [20, 120, 100, 200], attrs: `parentG="${G(201)}" assetG="${G(20)}"` })
    + obj('textBox', 203, { at: [100, 130, 220, 170], attrs: `parentG="${G(201)}"`, plain: 'Move together' })
    + obj('rect', 204, { at: [300, 300, 500, 400], plain: 'Drop here' });
  const grouped = importStory(pkg({ parts: [slide(101, { shapes: groupShapes })] }), { assetsDir: path.join(dir, 'assets'), courseDir: dir }).doc;
  publishWeb(grouped, path.join(dir, 'grouped'), { courseDir: dir });
  groupUrl = pathToFileURL(path.join(dir, 'grouped', 'index.html')).href;
});
test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
test.beforeEach(async ({ context }) => { await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, r => r.abort()); });

test('authored choice boxes stay on the slide and remain answerable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  const form = page.locator('.cf-question');
  await expect(form).toHaveClass(/cf-authored/);
  await expect(form.locator('legend')).toHaveCSS('left', '60px');
  await expect(form.locator('legend')).toHaveCSS('top', '30px');
  await expect(form.locator('legend')).toHaveCSS('font-size', '16px');
  await expect(form.locator('legend')).toHaveCSS('font-weight', '400');
  await expect(form.locator('legend')).toHaveCSS('font-style', 'normal');
  await expect(form.locator('.cf-choice').first()).toHaveCSS('left', '100px');
  await expect(form.locator('.cf-choice').first()).toHaveCSS('top', '150px');
  await expect(form.locator('.cf-choice').first()).toHaveCSS('font-size', '16px');
  await page.getByRole('radio', { name: 'One', exact: true }).check();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Correct');
});

test('authored choices retain the readable mobile fallback', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto(url);
  const form = page.locator('.cf-question');
  await expect(form).not.toHaveClass(/cf-authored/);
  const box = await form.locator('.cf-choice').first().boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('radio', { name: 'One', exact: true }).check();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('large source slides retain authored question positions on a normal desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(largeUrl);
  await expect(page.locator('.cf-question')).toHaveClass(/cf-authored/);
});

test('a grouped picture and label follow the pointer and remain together after drop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(groupUrl);
  const item = page.locator(`[data-id="${ID('o', 201)}"]`), label = page.locator(`[data-id="${ID('o', 203)}"]`);
  const start = await item.boundingBox(), target = await page.locator(`[data-id="${ID('o', 204)}"]`).boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 });
  await expect(label).not.toHaveCSS('transform', 'none');
  await page.mouse.up();
  await expect(label).toHaveCSS('left', '380px');
  await expect(label).toHaveCSS('top', '310px');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Correct');
});
