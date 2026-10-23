// Lessons-mode editor E2E: the human path through the lessons view must produce exactly what the registry
// produces for agents; reorder/duplicate/delete are undoable commands; preview plays; screenshots in light/dark at 1440/1024.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse, serialize, validate, BLOCK_TYPES } from '../../packages/schema/index.js';

const TOKEN = 'e2e-lessons-token-0123456789';
const SHOTS = fileURLToPath(new URL('../../.tmp/', import.meta.url));
const SAMPLE = fileURLToPath(new URL('../../samples/lab-basics-lessons.course.json', import.meta.url));
let server, base, root;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-lessons-editor-e2e-'));
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.cpSync(fileURLToPath(new URL('../../samples/assets', import.meta.url)), path.join(root, 'assets'), { recursive: true });
  server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});
const external = [];
const pageErrors = [];
test.beforeEach(async ({ context, page }) => {
  external.length = 0; pageErrors.length = 0;
  await context.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => { external.push(route.request().url()); return route.abort(); });
  page.on('pageerror', (e) => pageErrors.push(e.message));
});
test.afterEach(() => { expect(external).toEqual([]); expect(pageErrors).toEqual([]); });

const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');
async function commit(locator, value) { await locator.fill(String(value)); await locator.press('Tab'); await idle(locator.page()); }
async function choose(locator, value) { await locator.selectOption(String(value)); await idle(locator.page()); }
const fileOf = (name) => path.join(root, `${name}.course.json`);
const saved = (name) => JSON.parse(fs.readFileSync(fileOf(name), 'utf8'));
const built = (doc) => JSON.parse(serialize(doc));
const depth = (name) => io.history.depth(fileOf(name)).undo;
// Every visible control must have an accessible name and say what it does (data-cmd = registry command or tool, data-ui = navigation).
async function audit(page) {
  const bad = await page.evaluate(() => [...document.querySelectorAll('button, input, select, textarea, a[href], [role=button], [role=tab]')]
    .filter((el) => el.getClientRects().length)
    .filter((el) => !(el.getAttribute('aria-label') || el.labels?.length || el.getAttribute('aria-labelledby') || el.textContent.trim()) || !(el.dataset.cmd || el.dataset.ui))
    .map((el) => el.outerHTML.slice(0, 160)));
  expect(bad).toEqual([]);
}
const shot = async (page, name) => { await audit(page); await page.screenshot({ path: path.join(SHOTS, `lessons-editor-${name}.png`) }); };
const lessonsCourse = (title) => emptyCourse({ title, mode: 'lessons' });
function seed(name, title, cmds = []) {
  const r = applyAll(lessonsCourse(title), cmds);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  io.saveCourse(fileOf(name), r.doc);
  return r.doc;
}
async function open(page, name, title) {
  await page.goto(`${base}/?token=${TOKEN}#${name}`);
  await expect(page.locator('#course-title')).toHaveText(title);
  await expect(page.locator('#lapp')).toBeVisible();
  await idle(page);
}
const nextId = (page, id) => page.locator('#lv-next-id').fill(id);
async function insert(page, type, id) {
  if (id) await nextId(page, id);
  await page.getByRole('button', { name: 'Insert block', exact: true }).click();
  await page.locator(`#lv-mi-${type}`).click();
  await idle(page);
  if (id) await expect(page.locator(`#lv-card-${id}`)).toHaveClass(/sel/);
}
const card = (page, id) => page.locator(`#lv-b-${id}`);

// The 3-lesson course an agent builds with one batch (ids typed in the UI, so no id normalization is needed).
const REFERENCE = [
  { cmd: 'section.add', args: { id: 'sec-a', title: 'Basics' } },
  { cmd: 'lesson.add', args: { id: 'l-one', section: 'sec-a', title: 'Protective equipment', blocks: [
    { id: 'b-acc', type: 'accordion', items: [{ title: 'Goggles', text: 'Protect your eyes.' }, { title: 'Gloves', text: 'Protect your hands.' }] },
    { id: 'b-gate1', type: 'continue', require: 'above' },
    { id: 'b-tabs', type: 'tabs', items: [{ title: 'Before', text: 'Read the label.' }, { title: 'After', text: 'Clean the bench.' }] },
    { id: 'b-cards', type: 'flashcards', items: [{ front: 'Splash risk', back: 'Goggles' }], style: { width: 'wide', background: '#eef1f9' } },
    { id: 'b-gate2', type: 'continue', require: 'allAbove', label: 'I have explored both' },
  ] } },
  { cmd: 'asset.add', args: { id: 'a-bench', path: 'assets/lab-bench.svg', alt: 'A lab bench with goggles and a flask' } },
  { cmd: 'lesson.add', args: { id: 'l-two', section: 'sec-a', title: 'Check yourself', blocks: [
    { id: 'b-kc', type: 'question', kind: 'mc', prompt: 'Which protects your eyes?', attempts: 2, feedback: { incorrect: 'Look again.' },
      choices: [{ id: 'a', label: 'Goggles', correct: true, feedback: 'Right.' }, { id: 'b', label: 'Gloves' }, { id: 'c', label: 'A scarf' }] },
    { id: 'b-img', type: 'image', image: 'a-bench', caption: 'The bench' },
  ] } },
  { cmd: 'section.add', args: { id: 'sec-q', title: 'Check' } },
  { cmd: 'lesson.add', args: { id: 'l-quiz', section: 'sec-q', title: 'Final quiz', kind: 'quiz', passPercent: 75, attempts: 2, blocks: [
    { id: 'q-1', type: 'question', kind: 'mc', prompt: 'Pick the goggles', choices: [{ id: 'a', label: 'Goggles', correct: true }, { id: 'b', label: 'Sandals' }] },
    { id: 'q-2', type: 'question', kind: 'matching', prompt: 'Match each item', pairs: [{ left: 'Eyes', right: 'Goggles' }, { left: 'Hands', right: 'Gloves' }] },
  ] } },
  { cmd: 'block.add', args: { lesson: 'l-two', id: 'b-go', type: 'button', label: 'Take the quiz', toLesson: 'l-quiz' } },
  { cmd: 'course.set', args: { description: 'Two short lessons, then a quiz.' } },
  { cmd: 'player.set', args: { navigation: 'restricted', theme: { accent: '#0b5d5d' } } },
  { cmd: 'tracking.set', args: { complete: [{ quiz: 'l-quiz' }], status: 'passed-failed' } },
];

test('parity: a 3-lesson course built only through the lessons UI equals the reference command batch', async ({ page }) => {
  test.setTimeout(120000); // a long UI journey (~60 edits); parallel workers slow it down
  await page.goto(`${base}/?token=${TOKEN}`);
  await page.getByLabel('Lessons', { exact: true }).check();
  await page.getByLabel('File name').fill('lparity');
  await page.getByLabel('Course title').fill('Lab Basics');
  await shot(page, 'picker-mode');
  await page.getByRole('button', { name: 'Create course' }).click();
  await expect(page.locator('#lapp')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  await idle(page);
  expect(saved('lparity').mode).toBe('lessons');

  // outline: section, lesson
  await nextId(page, 'sec-a');
  await page.getByRole('button', { name: 'Add section' }).click();
  await idle(page);
  await commit(page.getByLabel('Section title (sec-a)'), 'Basics');
  await nextId(page, 'l-one');
  await page.getByRole('button', { name: 'Add lesson', exact: true }).click();
  await idle(page);
  await commit(page.locator('#lf-title'), 'Protective equipment');

  // lesson 1: accordion, gate (above), tabs, flashcards (styled), gate (all above)
  await insert(page, 'accordion', 'b-acc');
  await commit(page.getByLabel('Item 1 title'), 'Goggles');
  await commit(page.getByLabel('Item 1 text'), 'Protect your eyes.');
  await page.getByRole('button', { name: 'Add item' }).click();
  await idle(page);
  await commit(page.getByLabel('Item 2 title'), 'Gloves');
  await commit(page.getByLabel('Item 2 text'), 'Protect your hands.');
  await insert(page, 'continue', 'b-gate1');
  await choose(page.getByLabel('Learners must complete'), 'above');
  await insert(page, 'tabs', 'b-tabs');
  await commit(page.getByLabel('Item 1 title'), 'Before');
  await commit(page.getByLabel('Item 1 text'), 'Read the label.');
  await page.getByRole('button', { name: 'Add item' }).click();
  await idle(page);
  await commit(page.getByLabel('Item 2 title'), 'After');
  await commit(page.getByLabel('Item 2 text'), 'Clean the bench.');
  await insert(page, 'flashcards', 'b-cards');
  await commit(page.getByLabel('Card 1 front'), 'Splash risk');
  await commit(page.getByLabel('Card 1 back'), 'Goggles');
  await choose(page.getByLabel('Width'), 'wide');
  await commit(page.locator('#bs-background'), '#eef1f9');
  await insert(page, 'continue', 'b-gate2');
  await choose(page.getByLabel('Learners must complete'), 'allAbove');
  await commit(page.getByLabel('Button label (optional; default Continue)'), 'I have explored both');
  await expect(page.locator('#lv-l-l-one .lv-status')).toHaveText('5 blocks · 2 gates');

  // lesson 2: knowledge check (per-choice feedback, attempts), image (registers a file), button
  await nextId(page, 'l-two');
  await page.getByRole('button', { name: 'Add lesson', exact: true }).click();
  await idle(page);
  await commit(page.locator('#lf-title'), 'Check yourself');
  await insert(page, 'question', 'b-kc');
  await commit(page.getByLabel('Prompt'), 'Which protects your eyes?');
  await commit(page.getByLabel('Choice 1 label'), 'Goggles');
  await commit(page.getByLabel('Choice 1 feedback (optional)'), 'Right.');
  await commit(page.getByLabel('Choice 2 label'), 'Gloves');
  await page.getByRole('button', { name: 'Add choice' }).click();
  await idle(page);
  await expect(page.getByLabel('Choice 3 id')).toHaveValue('c');
  await commit(page.getByLabel('Choice 3 label'), 'A scarf');
  await commit(page.getByLabel('When incorrect'), 'Look again.');
  await commit(page.getByLabel('Attempts (empty or 0 = unlimited)'), 2);
  await nextId(page, 'b-img');
  await page.getByRole('button', { name: 'Insert block', exact: true }).click();
  await page.locator('#lv-mi-image').click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('File path', { exact: true }).fill('assets/lab-bench.svg');
  await dlg.getByLabel(/^Alt text/).fill('A lab bench with goggles and a flask');
  await dlg.getByLabel('Asset id (optional)').fill('a-bench');
  await dlg.getByRole('button', { name: 'Register file' }).click();
  await idle(page);
  await expect(page.locator('#lv-card-b-img img')).toBeVisible();
  await commit(page.getByLabel('Caption (optional)'), 'The bench');
  await insert(page, 'button', 'b-go');
  await commit(page.getByLabel('Button label'), 'Take the quiz');

  // lesson 3: a quiz in a new section (mc + matching), settings
  await nextId(page, 'sec-q');
  await page.getByRole('button', { name: 'Add section' }).click();
  await idle(page);
  await commit(page.getByLabel('Section title (sec-q)'), 'Check');
  await nextId(page, 'l-quiz');
  await page.getByRole('button', { name: 'Add lesson', exact: true }).click();
  await idle(page);
  await commit(page.locator('#lf-title'), 'Final quiz');
  await choose(page.getByLabel('Kind'), 'quiz');
  await commit(page.getByLabel('Pass mark (%)'), 75);
  await commit(page.getByLabel('Attempts (0 = unlimited)'), 2);
  await page.getByRole('button', { name: 'Insert block', exact: true }).click();
  await expect(page.locator('#lv-mi-accordion')).toBeDisabled(); // quiz lessons hold only questions
  await page.keyboard.press('Escape');
  await insert(page, 'question', 'q-1');
  await commit(page.getByLabel('Prompt'), 'Pick the goggles');
  await commit(page.getByLabel('Choice 1 label'), 'Goggles');
  await commit(page.getByLabel('Choice 2 label'), 'Sandals');
  await insert(page, 'question', 'q-2');
  await choose(page.getByLabel('Question type'), 'matching');
  await commit(page.getByLabel('Prompt'), 'Match each item');
  await commit(page.getByLabel('Pair 1 left'), 'Eyes');
  await commit(page.getByLabel('Pair 1 right'), 'Goggles');
  await commit(page.getByLabel('Pair 2 left'), 'Hands');
  await commit(page.getByLabel('Pair 2 right'), 'Gloves');
  await expect(page.locator('#lv-l-l-quiz .lv-status')).toHaveText('2 questions · pass 75%');

  // back to the button: point it at the quiz
  await page.locator('#lv-l-l-two').click();
  await card(page, 'b-go').click();
  await choose(page.getByLabel('Lesson', { exact: true }), 'l-quiz');

  // course settings
  await page.getByRole('tab', { name: 'Course' }).click();
  await commit(page.getByLabel('Description (shown on the cover)'), 'Two short lessons, then a quiz.');
  await choose(page.getByLabel('Learners move through lessons'), 'restricted');
  await commit(page.locator('#ct-accent'), '#0b5d5d');
  await page.getByLabel('Quiz result').check();
  await idle(page);
  await page.getByLabel('Lessons completed').uncheck();
  await idle(page);
  await choose(page.getByLabel('Report status as'), 'passed-failed');
  await expect(page.locator('#lv-l-l-quiz .lv-status')).toHaveText('2 questions · pass 75% · tracked');

  const ref = applyAll(lessonsCourse('Lab Basics'), REFERENCE);
  expect(ref.ok, JSON.stringify(ref.errors)).toBe(true);
  expect(saved('lparity')).toEqual(built(ref.doc));
  expect(validate(saved('lparity'))).toEqual([]);

  // the Agent dialog teaches the same thing for the last edit; course creation carried the mode
  await page.getByRole('button', { name: /^Command log/ }).click();
  await expect(page.locator('#log-list')).toContainText('"mode":"lessons"');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('tracking.set');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
});

test('reorder, duplicate and delete blocks, lessons and sections (buttons, keyboard, drag); undo and redo', async ({ page }) => {
  const doc = seed('reorder', 'Reorder', [
    { cmd: 'section.add', args: { id: 'sec-1', title: 'One' } },
    { cmd: 'lesson.add', args: { id: 'l-a', title: 'Alpha', blocks: [
      { id: 'b-1', type: 'heading', text: 'First' }, { id: 'b-2', type: 'text', text: 'Second' }, { id: 'b-3', type: 'quote', text: 'Third' }, { id: 'b-4', type: 'divider' }] } },
    { cmd: 'lesson.add', args: { id: 'l-b', title: 'Beta', blocks: [{ id: 'b-go', type: 'button', label: 'Go', toLesson: 'l-c' }] } },
    { cmd: 'section.add', args: { id: 'sec-2', title: 'Two' } },
    { cmd: 'lesson.add', args: { id: 'l-c', section: 'sec-2', title: 'Gamma' } },
  ]);
  await open(page, 'reorder', 'Reorder');
  const order = () => saved('reorder').sections[0].lessons[0].blocks.map((b) => b.id);
  await card(page, 'b-1').click();
  await page.getByRole('button', { name: 'Move block down' }).click(); // b-2 b-1 b-3 b-4
  await idle(page);
  await expect(card(page, 'b-1')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#lv-card-b-4').dragTo(page.locator('#lv-card-b-2')); // drop takes the target's index: b-4 b-2 b-1 b-3
  await idle(page);
  await expect.poll(order).toEqual(['b-4', 'b-2', 'b-1', 'b-3']);
  await card(page, 'b-3').focus(); // Tab-focus selects
  await expect(card(page, 'b-3')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Alt+ArrowUp'); // b-4 b-2 b-3 b-1
  await idle(page);
  await nextId(page, 'b-3c');
  await page.locator('#lv-b-b-3-dup').click(); // b-4 b-2 b-3 b-3c b-1
  await idle(page);
  await expect(card(page, 'b-3c')).toBeFocused();
  await page.keyboard.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#lv-card-b-3c')).toHaveCount(0);
  await idle(page);
  await expect(card(page, 'b-1')).toBeFocused(); // the next block takes the selection
  await page.locator('#lv-card-b-2').dragTo(page.locator('#lv-l-l-b')); // drop a block on another lesson in the outline
  await idle(page);
  // lessons and sections
  await page.locator('#lv-l-l-a').click();
  await page.getByRole('button', { name: 'Move lesson down' }).click();
  await idle(page);
  await page.locator('#lv-l-l-c').locator('xpath=..').dragTo(page.locator('#lv-l-l-b').locator('xpath=..')); // l-c into section One, at Beta's index
  await idle(page);
  await page.getByRole('button', { name: 'Move section Two up' }).click();
  await idle(page);
  await nextId(page, 'l-a2');
  await page.locator('#lv-l-l-a').click();
  await page.getByRole('button', { name: 'Duplicate lesson' }).click();
  await idle(page);
  await expect(page.locator('#lf-title')).toHaveValue('Alpha (copy)');
  await page.locator('#lv-l-l-c').click();
  await page.getByRole('button', { name: 'Delete lesson' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  const still = page.getByRole('dialog', { name: /still in use/ });
  await expect(still).toContainText('toLesson');
  await shot(page, 'delete-in-use');
  await still.getByRole('button', { name: 'Delete and remove the references' }).click();
  await expect(page.locator('#lv-l-l-c')).toHaveCount(0);
  await idle(page);

  const steps = [
    { cmd: 'block.move', args: { id: 'b-1', index: 1 } },
    { cmd: 'block.move', args: { id: 'b-4', lesson: 'l-a', index: 0 } },
    { cmd: 'block.move', args: { id: 'b-3', index: 2 } },
    { cmd: 'block.duplicate', args: { id: 'b-3', newId: 'b-3c' } },
    { cmd: 'block.remove', args: { id: 'b-3c' } },
    { cmd: 'block.move', args: { id: 'b-2', lesson: 'l-b' } },
    { cmd: 'lesson.move', args: { id: 'l-a', index: 1 } },
    { cmd: 'lesson.move', args: { id: 'l-c', section: 'sec-1', index: 0 } },
    { cmd: 'section.move', args: { id: 'sec-2', index: 0 } },
    { cmd: 'lesson.duplicate', args: { id: 'l-a', newId: 'l-a2', title: 'Alpha (copy)' } },
    { cmd: 'lesson.remove', args: { id: 'l-c', force: true } },
  ];
  const all = applyAll(doc, steps);
  expect(all.ok, JSON.stringify(all.errors)).toBe(true);
  const file = saved('reorder');
  // lesson.duplicate generates block ids: compare those structurally, everything else exactly
  const dupIds = file.sections[1].lessons.find((l) => l.id === 'l-a2').blocks.map((b) => b.id);
  const refDup = all.doc.sections[1].lessons.find((l) => l.id === 'l-a2');
  refDup.blocks.forEach((b, i) => { b.id = dupIds[i]; });
  expect(file).toEqual(built(all.doc));
  expect(depth('reorder')).toBe(steps.length);
  expect(file.sections.map((s) => [s.id, (s.lessons ?? []).map((l) => l.id)])).toEqual([['sec-2', []], ['sec-1', ['l-b', 'l-a', 'l-a2']]]);
  expect(file.sections[1].lessons[0].blocks.map((b) => b.id)).toEqual(['b-2']); // the button to l-c went with it (force)

  await page.getByRole('button', { name: /^Undo/ }).click(); // the forced delete comes back, references included
  await idle(page);
  await expect(page.locator('#lv-l-l-c')).toBeVisible();
  const before = applyAll(doc, steps.slice(0, -1)).doc;
  before.sections[1].lessons.find((l) => l.id === 'l-a2').blocks.forEach((b, i) => { b.id = dupIds[i]; });
  expect(saved('reorder')).toEqual(built(before));
  for (let i = 0; i < steps.length - 1; i++) { await page.keyboard.press('Control+z'); await idle(page); }
  expect(saved('reorder')).toEqual(built(doc));
  await page.keyboard.press('Control+y');
  await idle(page);
  expect(saved('reorder')).toEqual(built(applyAll(doc, steps.slice(0, 1)).doc));
});

test('preview opens a lessons course and plays the first lesson; Publish Web works', async ({ page }) => {
  fs.cpSync(SAMPLE, fileOf('sample'));
  await open(page, 'sample', 'Lab Basics');
  await page.getByRole('button', { name: 'Preview' }).click();
  const frame = page.frameLocator('dialog iframe');
  await frame.getByRole('button', { name: 'Start course' }).click();
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText('Welcome to the lab');
  await expect(frame.locator('.cfl-lesson-head .cfl-meta')).toContainText('Lesson 1 of 4');
  await shot(page, 'preview');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Publish Web' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Published the web package' })).toBeVisible();
  expect(fs.existsSync(path.join(root, 'dist', 'sample-web', 'index.html'))).toBe(true);
});

test('Check lists lessons issues; Go to selects the block (P1.7 for lessons)', async ({ page }) => {
  seed('lcheck', 'Lessons check', [
    { cmd: 'asset.add', args: { id: 'a-pic', path: 'assets/lab-bench.svg' } },
    { cmd: 'section.add', args: { id: 'sec-1', title: 'One' } },
    { cmd: 'lesson.add', args: { id: 'l-a', title: 'Alpha', blocks: [{ id: 'b-t', type: 'text', text: 'Hi' }, { id: 'b-pic', type: 'image', image: 'a-pic' }] } },
  ]);
  await open(page, 'lcheck', 'Lessons check');
  await page.getByRole('button', { name: 'Check' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText(/alt/i);
  await dlg.getByRole('button', { name: /Go to \/sections\/0\/lessons\/0\/blocks\/1/ }).click();
  await expect(card(page, 'b-pic')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('This image has no alt text')).toBeVisible();
  await commit(page.getByLabel(/^Alt text/), 'A lab bench');
  expect(saved('lcheck').sections[0].lessons[0].blocks[1].alt).toBe('A lab bench');
});

test('reusable lesson: Export downloads a package; Insert from file adds it with fresh ids (P1.4 for lessons)', async ({ page }) => {
  seed('lreuse', 'Lesson reuse', [
    { cmd: 'section.add', args: { id: 'sec-1', title: 'One' } },
    { cmd: 'lesson.add', args: { id: 'l-a', title: 'Alpha', blocks: [{ id: 'b-acc', type: 'accordion', items: [{ title: 'x', text: 'y' }] }, { id: 'b-g', type: 'continue', require: 'above' }] } },
  ]);
  await open(page, 'lreuse', 'Lesson reuse');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export lesson as a reusable file' }).click()]);
  expect(download.suggestedFilename()).toBe('l-a.lesson.json');
  const file = path.join(root, 'alpha.lesson.json');
  await download.saveAs(file);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).kind).toBe('cf.lesson/1');
  await nextId(page, 'l-a-again');
  await page.locator('#import-lesson-file').setInputFiles(file);
  await expect(page.getByText('Inserted the reusable lesson.')).toBeVisible();
  await expect(page.locator('#lv-l-l-a-again')).toHaveAttribute('aria-current', 'true');
  const lessons = io.loadCourse(fileOf('lreuse')).sections[0].lessons;
  expect(lessons.map((l) => l.id)).toEqual(['l-a', 'l-a-again']);
  expect(lessons[1].blocks.map((b) => b.type)).toEqual(['accordion', 'continue']);
  expect(new Set(lessons.flatMap((l) => l.blocks.map((b) => b.id))).size).toBe(4); // fresh block ids
});

test('every block type inserts from the menu with a valid default; visual review at 1440 and 1024, light and dark', async ({ page }) => {
  test.setTimeout(120000);
  fs.cpSync(SAMPLE, fileOf('visual'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'visual', 'Lab Basics');
  await shot(page, 'light-1440-cover-lesson');
  await page.locator('#lv-l-l-ppe').click();
  await card(page, 'b-p-acc').click();
  await shot(page, 'light-1440-accordion');
  await card(page, 'b-p-kc').click();
  await shot(page, 'light-1440-knowledge-check');
  await page.getByRole('button', { name: 'Insert block', exact: true }).click();
  const menu = page.locator('#lv-menu');
  await expect(menu).toBeVisible();
  const types = await menu.locator('[id^=lv-mi-]').evaluateAll((els) => els.map((e) => e.id.slice(6)));
  expect(types.sort()).toEqual(Object.keys(BLOCK_TYPES).sort());
  await shot(page, 'light-1440-insert-menu');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('button', { name: 'Insert block', exact: true })).toBeFocused(); // focus returns to the menu button

  // a fresh lesson with one block of every type (asset blocks reuse the registered image; video and audio register a file)
  await nextId(page, 'l-all');
  await page.getByRole('button', { name: 'Add lesson', exact: true }).click();
  await idle(page);
  for (const t of Object.keys(BLOCK_TYPES)) {
    await page.getByRole('button', { name: 'Insert block', exact: true }).click();
    await page.locator(`#lv-mi-${t}`).click();
    if (t === 'video' || t === 'audio') {
      const dlg = page.getByRole('dialog');
      await dlg.getByLabel('File path', { exact: true }).fill(`assets/clip.${t === 'video' ? 'mp4' : 'mp3'}`);
      await dlg.getByRole('button', { name: 'Register file' }).click();
    }
    await idle(page);
  }
  const all = io.loadCourse(fileOf('visual')).sections.flatMap((s) => s.lessons).find((l) => l.id === 'l-all');
  expect(all.blocks.map((b) => b.type)).toEqual(Object.keys(BLOCK_TYPES));
  expect(validate(saved('visual'))).toEqual([]);
  await page.locator('#lv-viewport').evaluate((el) => { el.scrollTop = 0; });
  await shot(page, 'light-1440-every-block');
  await page.getByRole('tab', { name: 'Course' }).click();
  await shot(page, 'light-1440-course');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('#lv-l-l-spill').click();
  await shot(page, 'dark-1440-lesson');
  await page.locator('#lv-l-l-quiz').click();
  await shot(page, 'dark-1440-quiz-settings');
  await page.locator('#lv-l-l-all').click();
  await card(page, all.blocks.find((b) => b.type === 'sorting').id).click();
  await shot(page, 'dark-1440-sorting');

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator('#lv-l-l-ppe').click();
  await card(page, 'b-p-tabs').click();
  await shot(page, 'dark-1024-tabs');
  await page.emulateMedia({ colorScheme: 'light' });
  await card(page, 'b-p-cards').click();
  await shot(page, 'light-1024-flashcards');
  await page.getByRole('tab', { name: 'Lesson' }).click();
  await shot(page, 'light-1024-lesson-tab');
  // keyboard: Tab from the toolbar reaches the page and the inspector; arrows switch inspector tabs
  await page.getByRole('tab', { name: 'Lesson' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Course' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Course' })).toHaveAttribute('aria-selected', 'true');
});
