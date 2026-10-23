// end to end: the published web package (file:) reviews a submitted quiz read-only, keyboard only, and
// returns to the results slide; Retry still works afterwards. Screenshots at 375 px and 1440 px, light and dark.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { publishWeb, validatePackage } from '../../packages/publisher/index.js';

const SHOTS = fileURLToPath(new URL('../../.tmp/', import.meta.url));
const ch = (...list) => list.map(([id, label, correct]) => ({ id, label, ...(correct ? { correct: true } : {}) }));
let dir, url;

test.beforeAll(() => {
  const r = applyAll(emptyCourse({ id: 'review', title: 'Review E2E' }), [
    { cmd: 'slide.add', args: { id: 's-intro', title: 'Welcome', objects: [{ id: 'o-hi', type: 'text', x: 80, y: 80, w: 1000, h: 80, text: 'A short quiz you can review.' }] } },
    { cmd: 'slide.add', args: { id: 's-q1', title: 'Sky', question: { type: 'mc', prompt: 'Which colour is a clear sky?', shuffle: false, choices: ch(['g', 'Green'], ['b', 'Blue', true]) } } },
    { cmd: 'slide.add', args: { id: 's-q2', title: 'Even', question: { type: 'mr', prompt: 'Pick the even numbers', shuffle: false, choices: ch(['two', 'Two', true], ['three', 'Three'], ['four', 'Four', true]) } } },
    { cmd: 'slide.add', args: { id: 's-q3', title: 'Colour', question: { type: 'fill', prompt: 'Type the word teal', answers: ['teal'] } } },
    { cmd: 'slide.add', args: { id: 's-q4', title: 'Pairs', question: { type: 'matching', prompt: 'Match the pairs', shuffle: false, choices: ch(['hot', 'Hot'], ['cold', 'Cold']), rows: [{ id: 'fire', label: 'Fire', choice: 'hot' }, { id: 'ice', label: 'Ice', choice: 'cold' }] } } },
    { cmd: 'quiz.add', args: { id: 'qz', title: 'Final check', questions: ['s-q1', 's-q2', 's-q3', 's-q4'] } },
    { cmd: 'quiz.addResults', args: { quiz: 'qz', id: 's-res', track: true } },
  ]);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-review-e2e-'));
  publishWeb(r.doc, path.join(dir, 'web'));
  expect(validatePackage(path.join(dir, 'web'))).toEqual([]);
  url = pathToFileURL(path.join(dir, 'web', 'index.html')).href;
  fs.mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let requests, errors;
test.beforeEach(async ({ context, page }) => {
  await context.route(/^(https?|wss?):\/\//, (r) => r.abort());
  requests = []; errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
});
test.afterEach(() => {
  expect(requests.filter((u) => !/^(file:|data:|blob:)/.test(u)), 'non-local requests').toEqual([]);
  expect(errors, 'page/console errors').toEqual([]);
});

async function tabTo(page, target, back = false) {
  for (let i = 0; i < 60; i++) {
    if (await target.evaluateAll((els) => els.includes(document.activeElement))) return;
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`keyboard focus never reached ${target}`);
}
const submit = async (page, ok) => {
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByRole('dialog', { name: ok ? 'Correct' : 'Incorrect' }).getByRole('button', { name: 'Continue' }).click();
};
/** Mouse run of the quiz: q1 wrong, q2 right, q3 right, q4 half wrong -> 50%, failed. */
async function takeQuiz(page) {
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('radio', { name: 'Green' }).check(); await submit(page, false);
  await page.getByRole('checkbox', { name: 'Two' }).check(); await page.getByRole('checkbox', { name: 'Four' }).check(); await submit(page, true);
  await page.getByRole('textbox', { name: 'Answer' }).fill('teal'); await submit(page, true);
  await page.getByLabel('Fire').selectOption('hot'); await page.getByLabel('Ice').selectOption('hot'); await submit(page, false);
  await expect(page.getByText('Your score: 50%')).toBeVisible();
}

test('keyboard only at 1440 px (file://): review each question read-only, Next back to the results, Exit review, Retry', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  await takeQuiz(page);
  const bar = page.getByRole('region', { name: 'Quiz review' });
  await expect(bar).toBeHidden();

  await tabTo(page, page.getByRole('button', { name: 'Review quiz' }));
  await page.keyboard.press('Enter');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Incorrect');
  await expect(bar).toContainText('Question 1 of 4');
  await expect(bar).toContainText('Your answer: Green');
  await expect(bar).toContainText('Correct answer: Blue');
  await expect(page.locator('.cf-sr[aria-live]')).toContainText('Question 1 of 4: Incorrect');
  await expect(page.getByRole('button', { name: 'Submit' })).toBeHidden();
  const green = page.getByRole('radio', { name: /Green/ }), blue = page.getByRole('radio', { name: /Blue/ });
  await expect(page.locator('.cf-choice', { hasText: 'Green' }).locator('.cf-tag')).toHaveText('Your answer');
  await expect(page.locator('.cf-choice', { hasText: 'Blue' }).locator('.cf-tag')).toHaveText('✓ Correct answer');
  await expect(green).toHaveAttribute('aria-disabled', 'true');
  await tabTo(page, green, true); // inputs stay focusable for reading
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(green).toBeChecked();
  await expect(blue).not.toBeChecked();
  await page.screenshot({ path: path.join(SHOTS, 'review-quiz-1440.png'), animations: 'disabled' });

  const next = page.getByRole('button', { name: 'Next' });
  await tabTo(page, next);
  await page.keyboard.press('Enter');
  await expect(bar).toContainText('Question 2 of 4');
  await expect(bar).toContainText('Correct');
  await expect(bar).not.toContainText('Incorrect');
  await expect(page.getByRole('checkbox', { name: /Two/ })).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(bar).toContainText('Question 3 of 4');
  const answer = page.getByRole('textbox', { name: 'Answer' });
  await expect(answer).toHaveValue('teal');
  await expect(answer).toHaveAttribute('readonly', '');
  await tabTo(page, answer, true);
  await page.keyboard.type('x');
  await expect(answer).toHaveValue('teal');
  await tabTo(page, next);
  await page.keyboard.press('Enter');
  await expect(bar).toContainText('Question 4 of 4');
  await expect(bar).toContainText('Your answer: Fire: Hot, Ice: Hot');
  const ice = page.getByLabel('Ice');
  await expect(ice).toHaveValue('hot');
  await expect(page.locator('.cf-match', { hasText: 'Ice' }).locator('.cf-tag')).toHaveText('✕ Correct answer: Cold');
  await expect(page.locator('.cf-match', { hasText: 'Fire' }).locator('.cf-tag')).toHaveText('✓ Correct');
  await tabTo(page, ice, true);
  await page.keyboard.press('ArrowDown');
  await expect(ice).toHaveValue('hot');
  await page.screenshot({ path: path.join(SHOTS, 'review-quiz-1440-matching.png'), animations: 'disabled' });

  await tabTo(page, next);
  await page.keyboard.press('Enter'); // past the last question: back to the results slide
  await expect(bar).toBeHidden();
  await expect(page.getByText('Your score: 50%')).toBeVisible();
  await expect(page.locator('.cf-slide-title')).toHaveText('Results');

  await tabTo(page, page.getByRole('button', { name: 'Review quiz' }));
  await page.keyboard.press('Enter');
  await tabTo(page, page.getByRole('button', { name: 'Exit review' }), true);
  await page.keyboard.press('Enter');
  await expect(bar).toBeHidden();
  await expect(page.locator('.cf-slide-title')).toHaveText('Results');

  await tabTo(page, page.getByRole('button', { name: 'Retry quiz' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('group', { name: 'Which colour is a clear sky?' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Green' })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'Green' })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
});

test('375 px and 1440 px, light and dark: the review bar and tags fit and adapt (screenshots)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto(url);
  await takeQuiz(page);
  await page.getByRole('button', { name: 'Review quiz' }).click();
  const bar = page.getByRole('region', { name: 'Quiz review' });
  await expect(bar).toContainText('Question 1 of 4');
  const bgs = {};
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: width === 375 ? 740 : 900 });
      await expect(bar.getByRole('button', { name: 'Exit review' })).toBeVisible();
      await expect(page.locator('.cf-choice', { hasText: 'Blue' }).locator('.cf-tag')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `no horizontal scroll at ${width}`).toBeLessThanOrEqual(width);
      const b = await bar.boundingBox();
      expect(b.x + b.width).toBeLessThanOrEqual(width);
      bgs[scheme] = await bar.evaluate((el) => getComputedStyle(el).backgroundColor);
      await page.screenshot({ path: path.join(SHOTS, `review-quiz-${width}-${scheme}.png`), animations: 'disabled' });
    }
  }
  expect(bgs.light).not.toBe(bgs.dark);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(bar).toContainText('Correct');
});
