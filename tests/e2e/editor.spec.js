// Editor E2E: the human path through the UI must produce exactly what the registry produces for agents.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';
import { apply, applyAll } from '../../packages/core/index.js';
import { emptyCourse, serialize, allIds, normalize } from '../../packages/schema/index.js';
import { pkg } from '../fixtures/synthetic/story-builder.js';

const TOKEN = 'e2e-token-0123456789abcdef';
const SHOTS = fileURLToPath(new URL('../../.tmp/', import.meta.url));
let server, base, root;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-editor-e2e-'));
  fs.mkdirSync(SHOTS, { recursive: true });
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
test.beforeEach(async ({ context }) => {
  // The editor makes no outbound requests; any attempt is blocked and fails the test.
  external.length = 0;
  await context.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => expect(external).toEqual([]));

const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');
async function commit(locator, value) { await locator.fill(String(value)); await locator.press('Tab'); await idle(locator.page()); }
const fileOf = (name) => path.join(root, `${name}.course.json`);
// Every visible control must have an accessible name and say what it does (data-cmd = registry command or MCP tool, data-ui = navigation).
async function audit(page) {
  const bad = await page.evaluate(() => [...document.querySelectorAll('button, input, select, textarea, a[href], [role=button], [role=tab]')]
    .filter((el) => el.getClientRects().length)
    .filter((el) => !(el.getAttribute('aria-label') || el.labels?.length || el.getAttribute('aria-labelledby') || el.textContent.trim()) || !(el.dataset.cmd || el.dataset.ui))
    .map((el) => el.outerHTML.slice(0, 140)));
  expect(bad).toEqual([]);
}
const shot = async (page, name) => { await audit(page); await page.screenshot({ path: path.join(SHOTS, `editor-${name}.png`) }); };
function seed(name, title, cmds = []) {
  const r = applyAll(emptyCourse({ title }), cmds);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  io.saveCourse(fileOf(name), r.doc);
}
async function open(page, name, title) {
  await page.goto(`${base}/?token=${TOKEN}#${name}`);
  await expect(page.locator('#course-title')).toHaveText(title);
  await idle(page);
}

test('SCORM publish button creates and displays the LMS upload ZIP', async ({ page }) => {
  seed('zip-course', 'ZIP course', [{ cmd:'slide.add', args:{ id:'s-zip', title:'Welcome' } }]);
  await open(page, 'zip-course', 'ZIP course');
  const response = page.waitForResponse(r => r.url().endsWith('/api/courses/zip-course/publish'));
  await page.getByRole('button', { name:'Publish SCORM 1.2' }).click();
  const result = await (await response).json();
  expect(result.ok).toBe(true);
  expect(result.zip).toBe(path.join(root, 'dist/zip-course-scorm12.zip').replaceAll('\\', '/'));
  expect(fs.existsSync(result.zip)).toBe(true);
  await expect(page.locator('.toast')).toContainText(result.zip);
  await shot(page, 'scorm-zip');
});

// The same 2-slide branching course an agent would build in one batch.
const REFERENCE = [
  { cmd: 'var.add', args: { name: 'visited', type: 'boolean', initial: false } },
  { cmd: 'slide.add', args: { id: 's-one', title: 'Start' } },
  { cmd: 'object.add', args: { slide: 's-one', id: 'o-go', type: 'button', text: 'Go', x: 540, y: 600, w: 200, h: 56 } },
  { cmd: 'slide.add', args: { id: 's-two', title: 'Branch' } },
  { cmd: 'layer.add', args: { slide: 's-two', id: 'l-info', title: 'Info' } },
  { cmd: 'object.add', args: { slide: 's-two', layer: 'l-info', id: 'o-info', type: 'text', text: 'You made it', x: 480, y: 330, w: 320, h: 60 } },
  { cmd: 'trigger.add', args: { slide: 's-two', id: 't-info', on: { event: 'timelineStart' }, if: { all: [{ var: 'visited', op: '==', value: true }] }, do: [{ action: 'showLayer', layer: 'l-info' }] } },
  { cmd: 'trigger.add', args: { slide: 's-one', id: 't-go', on: { event: 'click', target: 'o-go' }, do: [{ action: 'setVar', var: 'visited', op: 'set', value: true }, { action: 'jump', to: 's-two' }] } },
];

test('human path builds the same course as the reference command batch (parity)', async ({ page }) => {
  // Ids are entered explicitly in the UI (Next id, Layer ID, Trigger ID), so the comparison is a plain deep-equal.
  await page.goto(`${base}/?token=${TOKEN}`);
  await shot(page, 'picker');
  await page.getByLabel('File name').fill('parity');
  await page.getByLabel('Course title').fill('Parity Course');
  await page.getByLabel('File format', { exact: true }).selectOption('json');
  await page.getByRole('button', { name: 'Create course' }).click();
  await expect(page.locator('#course-title')).toHaveText('Parity Course');

  await page.getByRole('tab', { name: 'Variables' }).click();
  await page.getByLabel('New variable name').fill('visited');
  await page.getByLabel('New variable type').selectOption('boolean');
  await page.locator('button[data-cmd="var.add"]').click();
  await idle(page);
  await expect(page.getByLabel('Name of variable 1')).toHaveValue('visited');

  await page.getByLabel('Next id').fill('s-one');
  await page.getByRole('button', { name: 'Add slide' }).click();
  await idle(page);
  await page.getByRole('tab', { name: 'Slide', exact: true }).click();
  await commit(page.getByLabel('Slide title'), 'Start');

  await page.getByLabel('Next id').fill('o-go');
  await page.getByRole('button', { name: 'Insert button' }).click();
  await idle(page);
  await expect(page.locator('#obj-o-go')).toBeVisible();
  await commit(page.getByLabel('Text (%name% shows a variable)'), 'Go');
  await commit(page.getByLabel('Y', { exact: true }), 600);

  await page.getByLabel('Next id').fill('s-two');
  await page.getByRole('button', { name: 'Add slide' }).click();
  await idle(page);
  await page.getByRole('tab', { name: 'Slide', exact: true }).click();
  await commit(page.getByLabel('Slide title'), 'Branch');

  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByLabel('Layer ID (optional)').fill('l-info');
  await page.locator('#ly-new-title').fill('Info');
  await page.locator('button[data-cmd="layer.add"]').click();
  await idle(page);
  await expect(page.locator('#edit-layer')).toHaveValue('l-info');
  await page.getByRole('button', { name: 'Base layer' }).click(); // select-to-edit round trip
  await expect(page.locator('#edit-layer')).toHaveValue('');
  await page.getByRole('button', { name: 'Edit layer Info' }).click();
  await expect(page.locator('#edit-layer')).toHaveValue('l-info');
  await page.getByLabel('Next id').fill('o-info');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await idle(page);
  await commit(page.getByLabel('Text (%name% shows a variable)'), 'You made it');

  await page.locator('#edit-layer').selectOption('');
  await page.getByRole('tab', { name: 'Triggers' }).click();
  await page.getByRole('button', { name: '+ Add trigger' }).click();
  await page.getByLabel('Trigger ID (optional)').fill('t-info');
  await page.getByLabel('Event', { exact: true }).selectOption('timelineStart');
  await page.getByLabel('Conditions', { exact: true }).selectOption('all');
  await page.getByLabel('Condition 1 variable', { exact: true }).selectOption('visited');
  await page.getByLabel('Condition 1 operator', { exact: true }).selectOption('==');
  await page.getByLabel('Condition 1 value', { exact: true }).selectOption('true');
  await page.getByLabel('Action 1 type', { exact: true }).selectOption('showLayer');
  await page.getByLabel('Action 1 layer', { exact: true }).selectOption('l-info');
  await page.getByRole('button', { name: 'Add trigger', exact: true }).click();
  await idle(page);
  await expect(page.locator('.sentence')).toContainText(['t-info: timelineStart if visited == true → show l-info']);

  await page.locator('#slide-s-one').click();
  await page.getByRole('button', { name: '+ Add trigger' }).click();
  await page.getByLabel('Trigger ID (optional)').fill('t-go');
  await expect(page.getByLabel('Event', { exact: true })).toHaveValue('click');
  await page.getByLabel('Event object', { exact: true }).selectOption('o-go');
  await page.getByLabel('Action 1 type', { exact: true }).selectOption('setVar');
  await page.getByLabel('Action 1 variable', { exact: true }).selectOption('visited');
  await page.getByLabel('Action 1 operator', { exact: true }).selectOption('set');
  await page.getByLabel('Action 1 value', { exact: true }).selectOption('true');
  await page.getByRole('button', { name: '+ Action' }).click();
  await page.getByLabel('Action 2 type', { exact: true }).selectOption('jump');
  await page.getByLabel('Action 2 destination', { exact: true }).selectOption('s-two');
  await shot(page, 'trigger-form');
  await page.getByRole('button', { name: 'Add trigger', exact: true }).click();
  await idle(page);
  await expect(page.locator('.sentence')).toContainText(['t-go: click o-go → visited = true; jump s-two']);

  const ref = applyAll(emptyCourse({ title: 'Parity Course' }), REFERENCE);
  expect(ref.ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(fileOf('parity'), 'utf8'))).toEqual(JSON.parse(serialize(ref.doc)));

  // Parity teaching: the log holds the JSON of every batch; the Agent dialog shows the CLI and MCP equivalents.
  await page.locator('#obj-o-go').click();
  await page.getByRole('tab', { name: 'Triggers' }).click();
  await page.getByRole('button', { name: /^Command log/ }).click();
  await expect(page.locator('#log-list li').first()).toContainText('trigger.add');
  await shot(page, 'command-log');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText(`cf cmd ${fileOf('parity').split(path.sep).join('/')} '[{"cmd":"trigger.add"`); // root is outside cwd: absolute path
  await expect(dlg).toContainText('run_commands');
  await expect(dlg).toContainText('"file": "parity.course.json"');
  await shot(page, 'agent-dialog');
  await dlg.getByRole('button', { name: 'Close' }).click();
});

test('undo and redo restore the document (buttons and shortcuts)', async ({ page }) => {
  seed('undo-demo', 'Undo demo');
  await open(page, 'undo-demo', 'Undo demo');
  await page.getByRole('button', { name: 'Add slide' }).click();
  await idle(page);
  await expect(page.locator('.slide-btn')).toHaveCount(1);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await idle(page);
  await expect(page.locator('.slide-btn')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await idle(page);
  await expect(page.locator('.slide-btn')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await idle(page);
  await expect(page.locator('.slide-btn')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await idle(page);
  await expect(page.locator('.slide-btn')).toHaveCount(1);
  expect(io.loadCourse(fileOf('undo-demo')).slides).toHaveLength(1);
  expect(io.history.depth(fileOf('undo-demo'))).toMatchObject({ undo: 1, redo: 0 });
});

test('an external CLI-style edit appears live via SSE, keeping the selection', async ({ page }) => {
  seed('live', 'Live', [{ cmd: 'slide.add', args: { id: 's-a', title: 'First' } }]);
  await open(page, 'live', 'Live');
  await expect(page.locator('body')).toHaveAttribute('data-live', '1');
  await page.waitForTimeout(700); // fs.watchFile (500 ms poll) takes its baseline right after the client connects
  const r = io.runCommands(fileOf('live'), [{ cmd: 'slide.add', args: { id: 's-ext', title: 'From an agent' } }]);
  expect(r.ok).toBe(true);
  await expect(page.locator('#slide-s-ext')).toContainText('From an agent');
  await expect(page.getByRole('status').filter({ hasText: 'Updated by another client' })).toBeVisible();
  await page.locator('#slide-s-ext').click();
  io.runCommands(fileOf('live'), [{ cmd: 'slide.set', args: { id: 's-a', title: 'Renamed by an agent' } }]);
  await expect(page.locator('#slide-s-a')).toContainText('Renamed by an agent');
  await expect(page.locator('#slide-s-ext')).toHaveAttribute('aria-current', 'true');
});

test('server errors are shown inline and in a toast, never swallowed', async ({ page }) => {
  seed('errors', 'Errors', [{ cmd: 'slide.add', args: { id: 's-1', title: 'One' } }]);
  await open(page, 'errors', 'Errors');
  await page.getByRole('tab', { name: 'Variables' }).click();
  for (let i = 0; i < 2; i++) {
    await page.getByLabel('New variable name').fill('dup');
    await page.locator('button[data-cmd="var.add"]').click();
    await idle(page);
  }
  await expect(page.getByRole('alert').filter({ hasText: 'variable "dup" already exists' })).toBeVisible();
  await expect(page.getByLabel('New variable name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#var-new-name-err')).toContainText('already exists');

  await page.getByLabel('Next id').fill('Bad Id');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await idle(page);
  await expect(page.locator('#next-id')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert').filter({ hasText: 'must match' })).toBeVisible();
  await shot(page, 'errors');
  await page.getByRole('button', { name: /^Command log/ }).click();
  await expect(page.locator('#log-list li.err')).toHaveCount(2);
  expect(io.loadCourse(fileOf('errors')).variables).toHaveLength(1);
});

test('no lost work: save status, refused values stay, drafts are confirmed, a late save never reopens a closed course (M2)', async ({ page }) => {
  seed('safe', 'Safe', [
    { cmd: 'slide.add', args: { id: 's-1', title: 'One', objects: [{ id: 'o-t', type: 'text', text: 'Hi', x: 10, y: 10, w: 200, h: 40 }] } },
    { cmd: 'slide.add', args: { id: 's-2', title: 'Two' } },
    { cmd: 'slide.add', args: { id: 's-q', title: 'Quiz me', question: { type: 'mc', prompt: 'Pick one', choices: [{ id: 'a', label: 'A', correct: true }, { id: 'b', label: 'B' }] } } },
  ]);
  await open(page, 'safe', 'Safe');
  await page.locator('#obj-o-t').click();
  await commit(page.locator('#p-name'), 'Greeting');
  await expect(page.locator('#save-status')).toHaveText('All changes saved');
  await commit(page.locator('#p-w'), -5); // refused by the schema (minimum 0)
  await expect(page.locator('#p-w')).toHaveValue('-5');
  await expect(page.locator('#p-w')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#save-status')).toHaveText('Not saved');
  expect(io.loadCourse(fileOf('safe')).slides[0].objects[0].w).toBe(200);

  await page.locator('#slide-s-q').click();
  await expect(page.locator('#slide-s-q')).toHaveAttribute('aria-current', 'true');
  await page.getByRole('tab', { name: 'Question' }).click();
  await page.locator('#q-prompt').fill('A better prompt');
  await page.locator('#slide-s-2').click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Discard the unsaved question?');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#slide-s-q')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#q-prompt')).toHaveValue('A better prompt');
  await page.locator('#slide-s-2').click();
  await dlg.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.locator('#slide-s-2')).toHaveAttribute('aria-current', 'true');

  // A save still on its way when Courses is clicked: it lands in its own course, and the picker stays.
  await page.route('**/api/courses/safe/commands', async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.continue(); });
  await page.locator('#slide-s-1').click();
  await page.locator('#obj-o-t').click();
  await page.getByRole('tab', { name: 'Properties' }).click();
  await page.locator('#p-name').fill('Late');
  await page.locator('#p-name').press('Tab');
  await page.getByRole('button', { name: 'Courses' }).click();
  await expect(page.getByRole('heading', { name: 'Courses' })).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#course-file')).toHaveText('');
  expect(io.loadCourse(fileOf('safe')).slides[0].objects[0].name).toBe('Late');
  await page.unroute('**/api/courses/safe/commands');
});

test('canvas gestures: drag, resize, nudge and delete send one command each', async ({ page }) => {
  seed('canvas', 'Canvas', [
    { cmd: 'slide.add', args: { id: 's-1', title: 'Canvas' } },
    { cmd: 'object.add', args: { slide: 's-1', id: 'o-box', type: 'shape', x: 100, y: 100, w: 200, h: 100 } },
  ]);
  await open(page, 'canvas', 'Canvas');
  const box = page.locator('#obj-o-box');
  const zoom = await page.evaluate(() => Number(getComputedStyle(document.getElementById('stage')).getPropertyValue('--zoom')));
  const b = await box.boundingBox();
  await page.mouse.move(b.x + 20, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(b.x + 60, b.y + 50, { steps: 5 });
  await page.mouse.move(b.x + 20 + 100 * zoom, b.y + 20 + 50 * zoom, { steps: 5 });
  await page.mouse.up();
  await idle(page);
  let o = io.loadCourse(fileOf('canvas')).slides[0].objects[0];
  expect([o.x, o.y]).toEqual([200, 150]);
  const h = await page.locator('#obj-o-box .handle.h-se').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 50 * zoom, h.y + h.height / 2 + 20 * zoom, { steps: 5 });
  await page.mouse.up();
  await idle(page);
  o = io.loadCourse(fileOf('canvas')).slides[0].objects[0];
  expect([o.w, o.h]).toEqual([250, 120]);
  await box.focus();
  await page.keyboard.press('ArrowRight');
  await idle(page);
  await page.keyboard.press('Shift+ArrowDown');
  await idle(page);
  o = io.loadCourse(fileOf('canvas')).slides[0].objects[0];
  expect([o.x, o.y]).toEqual([201, 160]);
  expect(io.history.depth(fileOf('canvas')).undo).toBe(4); // drag + resize + 2 nudges: one command each
  // a held arrow key (30 presses, no waiting) lands exactly, shows on the canvas at once, and is
  // merged into a few edits instead of a backlog that keeps moving the object after the key is released.
  await page.route('**/api/courses/canvas/commands', async (route) => { await new Promise((r) => setTimeout(r, 300)); await route.continue(); }); // a slow save, as on a large course
  await box.focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight', { delay: 0 });
  await expect(page.locator('#obj-o-box')).toHaveCSS('left', '231px');
  await idle(page);
  expect(io.loadCourse(fileOf('canvas')).slides[0].objects[0].x).toBe(231);
  expect(io.history.depth(fileOf('canvas')).undo - 4).toBeLessThan(10);
  await page.unroute('**/api/courses/canvas/commands');
  await shot(page, 'canvas-selected');
  await page.locator('#obj-o-box').press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  // idle() can resolve before the confirmed delete is queued: wait for its visible result, then the file.
  await expect(page.locator('#obj-o-box')).toHaveCount(0);
  await expect.poll(() => io.loadCourse(fileOf('canvas')).slides[0].objects.length).toBe(0);
});

test('visual review: populated course in light, dark and at 1024 px', async ({ page }) => {
  seed('visual', 'Lab Safety 101', [
    { cmd: 'var.add', args: { name: 'score', type: 'number', initial: 0 } },
    { cmd: 'slide.add', args: { id: 's-intro', title: 'Welcome to the lab', objects: [
      { id: 'o-title', type: 'text', x: 80, y: 60, w: 1120, h: 90, text: 'Lab Safety 101', style: { fontSize: 54, bold: true, color: '#0b3d3d' } },
      { id: 'o-sub', type: 'text', x: 80, y: 160, w: 900, h: 80, text: 'Learn the three rules that keep everyone safe.', style: { fontSize: 26, color: '#334155' } },
      { id: 'o-card', type: 'shape', shape: 'rounded', x: 80, y: 280, w: 520, h: 300, style: { fill: '#e0efee' } },
      { id: 'o-start', type: 'button', x: 80, y: 610, w: 240, h: 64, text: 'Start', style: { fill: '#0b6e6e', radius: 10 } },
      { id: 'o-hint', type: 'hotspot', x: 700, y: 300, w: 300, h: 220 }] } },
    { cmd: 'layer.add', args: { slide: 's-intro', id: 'l-help', title: 'Help', objects: [{ id: 'o-help', type: 'text', x: 700, y: 540, w: 480, h: 60, text: 'Score: %score%' }] } },
    { cmd: 'trigger.add', args: { slide: 's-intro', id: 't-hint', on: { event: 'click', target: 'o-hint' }, if: { all: [{ var: 'score', op: '<', value: 50 }] }, do: [{ action: 'showLayer', layer: 'l-help' }], else: [{ action: 'jump', to: 'next' }] } },
    { cmd: 'slide.add', args: { id: 's-q1', title: 'Check', question: { type: 'mc', prompt: 'Where do goggles go?', choices: [{ id: 'a', label: 'On your head' }, { id: 'b', label: 'Over your eyes', correct: true }] } } },
    { cmd: 'quiz.add', args: { id: 'qz-final', title: 'Final check', questions: ['s-q1'] } },
  ]);
  await open(page, 'visual', 'Lab Safety 101');
  await page.locator('#obj-o-start').click();
  await shot(page, 'light-properties');
  await page.getByRole('tab', { name: 'Triggers' }).click();
  await page.getByRole('button', { name: 'Edit trigger t-hint' }).click();
  await shot(page, 'light-trigger-edit');
  await page.locator('#edit-layer').selectOption('l-help');
  await page.getByRole('tab', { name: 'Layers' }).click();
  await shot(page, 'light-layers');
  await page.locator('#slide-s-q1').click();
  await page.getByRole('tab', { name: 'Question' }).click();
  await page.getByLabel('Prompt').fill('Where do safety goggles go?');
  await page.getByRole('button', { name: '+ Choice' }).click();
  await page.getByLabel('Choice 3 label').fill('In your pocket');
  await page.getByRole('button', { name: 'Save question' }).click();
  await idle(page);
  const q = io.loadCourse(fileOf('visual')).slides.find((s) => s.id === 's-q1').question;
  expect([q.prompt, q.choices.map((c) => c.label)]).toEqual(['Where do safety goggles go?', ['On your head', 'Over your eyes', 'In your pocket']]);
  await shot(page, 'light-question');
  await page.getByRole('tab', { name: 'Course' }).click();
  await page.getByRole('button', { name: /^Add a results slide for Final check/ }).click();
  await idle(page);
  expect(io.loadCourse(fileOf('visual')).quizzes[0].results).toBeTruthy();
  await shot(page, 'light-course');
  await page.getByRole('button', { name: 'Publish Web' }).click();
  await idle(page);
  await expect(page.locator('.toast').filter({ hasText: /Published|not available yet/ })).toBeVisible();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('dialog').locator('iframe')).toBeVisible();
  await shot(page, 'preview');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('#slide-s-intro').click();
  await page.locator('#obj-o-start').click();
  await page.getByRole('tab', { name: 'States' }).click();
  await page.getByLabel('New state name').fill('hover');
  await page.getByRole('button', { name: 'Add state' }).click();
  await idle(page);
  await commit(page.getByLabel('Fill', { exact: true }), '#095c5c');
  await expect(page.locator('fieldset legend', { hasText: 'hover' })).toBeVisible();
  expect(io.loadCourse(fileOf('visual')).slides[0].objects.find((o) => o.id === 'o-start').states.hover).toEqual({ style: { fill: '#095c5c' } });
  await shot(page, 'dark-states');
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.getByRole('tab', { name: 'Properties' }).click();
  await shot(page, 'dark-1024');
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page.getByRole('note')).toBeVisible();
});

// ---------------- editor P1 ----------------
const saved = (name) => JSON.parse(fs.readFileSync(fileOf(name), 'utf8'));
const built = (doc) => JSON.parse(serialize(doc));
const depth = (name) => io.history.depth(fileOf(name)).undo;
function seedRef(name, title, cmds) { seed(name, title, cmds); return applyAll(emptyCourse({ title }), cmds).doc; }
/** Rename every id by order of appearance, so documents with generated ids compare structurally (references stay consistent). */
function canonIds(doc) {
  const map = new Map([...allIds(normalize(doc))].map((id, i) => [id, `#${i}`]));
  return JSON.parse(JSON.stringify(doc), (k, v) => (typeof v === 'string' && map.has(v) ? map.get(v) : v));
}

test('registry gaps from the UI: layer reorder, and emptied fields send null', async ({ page }) => {
  const doc = seedRef('gaps', 'Gaps', [
    { cmd: 'slide.add', args: { id: 's-1', title: 'Gaps', background: '#eeeeee', objects: [{ id: 'o-btn', type: 'button', text: 'Go', style: { fill: '#123456', bold: true }, states: { hover: { style: { fill: '#111111', color: '#ffffff' }, text: 'Hi' } } }] } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l-a', title: 'A' } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l-b', title: 'B' } },
    { cmd: 'trigger.add', args: { slide: 's-1', id: 't-1', name: 'Named', on: { event: 'click', target: 'o-btn' }, do: [{ action: 'showLayer', layer: 'l-a' }] } },
  ]);
  await open(page, 'gaps', 'Gaps');
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByRole('button', { name: 'Move layer A down' }).click();
  await idle(page);
  await expect(page.getByRole('button', { name: 'Move layer B up' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Slide', exact: true }).click();
  await commit(page.locator('#sl-background'), '');
  await page.locator('#obj-o-btn').click();
  await page.getByRole('tab', { name: 'Properties' }).click();
  await commit(page.locator('#p-fill'), '');
  await page.getByLabel('Bold').uncheck();
  await idle(page);
  await page.getByRole('tab', { name: 'States' }).click();
  await commit(page.locator('#st-hover-fill'), '');
  await commit(page.locator('#st-hover-text'), '');
  await page.getByRole('tab', { name: 'Triggers' }).click();
  await page.getByRole('button', { name: 'Edit trigger t-1' }).click();
  await page.getByLabel('Name (optional)').fill('');
  await page.getByRole('button', { name: 'Save trigger' }).click();
  await idle(page);
  const ref = applyAll(doc, [
    { cmd: 'layer.move', args: { id: 'l-a', index: 1 } },
    { cmd: 'slide.set', args: { id: 's-1', background: null } },
    { cmd: 'object.set', args: { id: 'o-btn', style: { fill: null, bold: null } } },
    { cmd: 'state.set', args: { target: 'o-btn', state: 'hover', style: { fill: null }, text: null } },
    { cmd: 'trigger.set', args: { id: 't-1', name: null } },
  ]);
  expect(ref.ok).toBe(true);
  expect(saved('gaps')).toEqual(built(ref.doc));
  const s = saved('gaps').slides[0];
  expect([s.background, s.objects[0].style, s.objects[0].states.hover, s.triggers[0].name, s.layers.map((l) => l.id)])
    .toEqual([undefined, undefined, { style: { color: '#ffffff' } }, undefined, ['l-b', 'l-a']]);
});

test('copy and paste: Ctrl+C/Ctrl+V on the same slide, another slide and a layer, Ctrl+D; triggers follow the copies', async ({ page }) => {
  const doc = seedRef('clip', 'Clip', [
    { cmd: 'slide.add', args: { id: 's-1', title: 'Source', objects: [
      { id: 'o-btn', type: 'button', text: 'Flip', x: 100, y: 100, w: 200, h: 56 },
      { id: 'o-card', type: 'shape', x: 400, y: 100, w: 200, h: 120 }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', id: 't-flip', on: { event: 'click', target: 'o-btn' }, do: [{ action: 'setState', target: 'o-card', state: 'hidden' }] } },
    { cmd: 'slide.add', args: { id: 's-2', title: 'Target' } },
    { cmd: 'layer.add', args: { slide: 's-2', id: 'l-2', title: 'Pop' } },
  ]);
  await open(page, 'clip', 'Clip');
  await page.locator('#obj-o-btn').click();
  await page.locator('#obj-o-card').click({ modifiers: ['Shift'] });
  await expect(page.locator('.obj.sel')).toHaveCount(2);
  await expect(page.locator('#btn-paste')).toBeDisabled();
  await page.keyboard.press('Control+c');
  await expect(page.locator('#btn-paste')).toBeEnabled();
  await page.keyboard.press('Control+v'); // same slide and layer: offset 20
  await idle(page);
  await expect(page.locator('.obj.sel')).toHaveCount(2);
  await page.locator('#slide-s-2').click();
  await page.keyboard.press('Control+v'); // another slide: same position
  await idle(page);
  await page.locator('#edit-layer').selectOption('l-2');
  await page.locator('#btn-paste').click(); // into a layer, from the toolbar
  await idle(page);
  await page.keyboard.press('Control+d'); // duplicate the pasted copies in place, +20
  await idle(page);
  await expect(page.locator('#stage .obj:not(.dim)')).toHaveCount(4);
  await shot(page, 'clipboard');
  const r1 = applyAll(doc, [
    { cmd: 'object.duplicate', args: { ids: ['o-btn', 'o-card'], slide: 's-1', layer: null, dx: 20, dy: 20 } },
    { cmd: 'object.duplicate', args: { ids: ['o-btn', 'o-card'], slide: 's-2', layer: null } },
    { cmd: 'object.duplicate', args: { ids: ['o-btn', 'o-card'], slide: 's-2', layer: 'l-2' } },
  ]);
  const r2 = apply(r1.doc, { cmd: 'object.duplicate', args: { ids: r1.results[2].ids, dx: 20, dy: 20 } });
  expect(r2.ok).toBe(true);
  const file = saved('clip');
  expect(canonIds(file)).toEqual(canonIds(built(r2.doc))); // same structure; copies got generated ids
  const s1 = file.slides[0], s2 = file.slides[1];
  expect(s1.objects.map((o) => [o.x, o.y])).toEqual([[100, 100], [400, 100], [120, 120], [420, 120]]);
  const [b2, c2] = s2.objects;
  expect([b2.id === 'o-btn', b2.x, b2.y, c2.x]).toEqual([false, 100, 100, 400]);
  expect([s2.triggers[0].on.target, s2.triggers[0].do[0].target]).toEqual([b2.id, c2.id]);
  expect(s2.layers[0].objects.map((o) => o.x)).toEqual([100, 400, 120, 420]);
  expect(s2.layers[0].triggers).toHaveLength(2);
  expect(depth('clip')).toBe(4);
});

test('multi-select: Shift/Ctrl+click, group drag and nudge, align, distribute, keyboard selection and delete; one batch each', async ({ page }) => {
  const doc = seedRef('multi', 'Multi', [{ cmd: 'slide.add', args: { id: 's-1', title: 'Multi', objects: [
    { id: 'o-a', type: 'shape', x: 100, y: 100, w: 100, h: 50 },
    { id: 'o-b', type: 'shape', x: 300, y: 200, w: 100, h: 80 },
    { id: 'o-c', type: 'shape', x: 700, y: 150, w: 150, h: 60 },
    { id: 'o-d', type: 'text', text: 'Footer', x: 50, y: 600, w: 300, h: 50 }] } }]);
  await open(page, 'multi', 'Multi');
  await page.locator('#obj-o-a').click();
  await page.locator('#obj-o-b').click({ modifiers: ['Shift'] });
  await page.locator('#obj-o-c').click({ modifiers: ['Control'] });
  await page.locator('#obj-o-c').click({ modifiers: ['Control'] }); // toggles it off again
  await expect(page.locator('.obj.sel')).toHaveCount(2);
  await page.locator('#obj-o-c').click({ modifiers: ['Control'] });
  await expect(page.locator('.obj.sel')).toHaveCount(3);
  await expect(page.locator('.obj .handle')).toHaveCount(0); // resizing is for one object
  await expect(page.locator('#tabpanel .badge')).toHaveText('3 objects');
  const zoom = await page.evaluate(() => Number(getComputedStyle(document.getElementById('stage')).getPropertyValue('--zoom')));
  const b = await page.locator('#obj-o-b').boundingBox();
  await page.mouse.move(b.x + 10, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + 30, b.y + 20, { steps: 4 });
  await page.mouse.move(b.x + 10 + 50 * zoom, b.y + 10 + 20 * zoom, { steps: 4 });
  await page.mouse.up();
  await idle(page);
  expect(depth('multi')).toBe(1);
  await expect(page.locator('.obj.sel')).toHaveCount(3);
  await page.keyboard.press('ArrowRight'); // focus is on o-b, inside the selection
  await idle(page);
  expect(depth('multi')).toBe(2);
  await page.getByRole('button', { name: 'Align top to the selection' }).click();
  await idle(page);
  await page.getByRole('button', { name: 'Distribute horizontally' }).click();
  await idle(page);
  await shot(page, 'multi-select');
  await page.locator('#obj-o-b').focus();
  await page.keyboard.press('Control+a');
  await expect(page.locator('.obj.sel')).toHaveCount(4);
  await page.keyboard.press('Escape');
  await expect(page.locator('.obj.sel')).toHaveCount(0);
  for (const id of ['o-a', 'o-d']) { await page.locator(`#tl-${id}-sel`).focus(); await page.keyboard.press('Space'); } // keyboard multi-select
  await expect(page.locator('.obj.sel')).toHaveCount(2);
  await page.getByRole('button', { name: 'Delete objects' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#stage .obj')).toHaveCount(2); // the dialog closes asynchronously, then the batch is sent
  await idle(page);
  const ref = applyAll(doc, [
    { cmd: 'object.set', args: { id: 'o-a', x: 151, y: 120 } }, { cmd: 'object.set', args: { id: 'o-b', x: 351, y: 220 } }, { cmd: 'object.set', args: { id: 'o-c', x: 751, y: 170 } },
    { cmd: 'object.align', args: { ids: ['o-a', 'o-b', 'o-c'], edge: 'top' } },
    { cmd: 'object.distribute', args: { ids: ['o-a', 'o-b', 'o-c'], axis: 'horizontal' } },
    { cmd: 'object.remove', args: { id: 'o-a' } }, { cmd: 'object.remove', args: { id: 'o-d' } },
  ]);
  expect(ref.ok).toBe(true);
  expect(saved('multi')).toEqual(built(ref.doc));
  expect(saved('multi').slides[0].objects.map((o) => [o.id, o.x, o.y])).toEqual([['o-b', 451, 120], ['o-c', 751, 120]]);
  expect(depth('multi')).toBe(5); // drag, nudge, align, distribute, delete
});

test('timeline: numbers, duration and bar drags send object.set, slide.set and layer.set', async ({ page }) => {
  const doc = seedRef('timed', 'Timed', [
    { cmd: 'slide.add', args: { id: 's-1', title: 'Timed', objects: [
      { id: 'o-a', type: 'text', text: 'Always', x: 100, y: 100, w: 300, h: 60 },
      { id: 'o-b', type: 'shape', x: 100, y: 300, w: 200, h: 100, start: 1000, end: 3000 }] } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l-1', title: 'Pop', objects: [{ id: 'o-l', type: 'text', text: 'Layer text', x: 50, y: 50, w: 200, h: 50 }] } },
  ]);
  await open(page, 'timed', 'Timed');
  await expect(page.locator('#timeline')).toBeVisible();
  await expect(page.locator('.tl-name')).toHaveText([/\(o-b\)$/, /\(o-a\)$/]); // front object first (name first, id second)
  await commit(page.getByLabel('o-a appears at (ms)'), 500);
  await commit(page.getByLabel('o-a disappears at (ms, empty = at the end)'), 4000);
  await commit(page.getByLabel('Slide duration (ms)'), 6000);
  const dragBy = async (sel, ms) => { // the timeline spans 6000 ms now
    const track = await page.locator(sel).locator('xpath=ancestor::div[contains(@class,"tl-track")]').boundingBox();
    const px = (ms / 6000) * track.width;
    const el = await page.locator(sel).boundingBox();
    const x = el.x + el.width / 2, y = el.y + el.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + px / 2, y, { steps: 3 });
    await page.mouse.move(x + px, y, { steps: 3 });
    await page.mouse.up();
    await idle(page);
  };
  await dragBy('#tl-o-b-bar .e-end', 1000); // end 3000 -> 4000
  await dragBy('#tl-o-b-bar', -500); // whole bar -> 500..3500
  await dragBy('#tl-o-a-bar .e-end', 3000); // past the slide end -> until the end (null)
  await expect(page.locator('#tl-o-a-end')).toHaveValue('');
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(page.locator('#timeline')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Timeline', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.locator('#edit-layer').selectOption('l-1');
  await expect(page.locator('#tl-title')).toHaveText('Timeline: layer Pop');
  await commit(page.getByLabel('Layer duration (ms)'), 3000);
  await shot(page, 'timeline');
  await page.locator('#edit-layer').selectOption('');
  await page.locator('#tl-o-b-name').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'timeline-dark');
  const ref = applyAll(doc, [
    { cmd: 'object.set', args: { id: 'o-a', start: 500 } },
    { cmd: 'object.set', args: { id: 'o-a', end: 4000 } },
    { cmd: 'slide.set', args: { id: 's-1', duration: 6000 } },
    { cmd: 'object.set', args: { id: 'o-b', end: 4000 } },
    { cmd: 'object.set', args: { id: 'o-b', start: 500, end: 3500 } },
    { cmd: 'object.set', args: { id: 'o-a', end: null } },
    { cmd: 'layer.set', args: { id: 'l-1', duration: 3000 } },
  ]);
  expect(ref.ok).toBe(true);
  expect(saved('timed')).toEqual(built(ref.doc));
  expect(depth('timed')).toBe(7);
});

test('shortcut help: ? and the Shortcuts button list every shortcut; ? typed in a field is just text', async ({ page }) => {
  seed('keys', 'Keys', [{ cmd: 'slide.add', args: { id: 's-1', title: 'K' } }]);
  await open(page, 'keys', 'Keys');
  await page.getByLabel('Next id').press('?');
  await expect(page.getByLabel('Next id')).toHaveValue('?');
  await expect(page.locator('#dlg')).not.toBeVisible();
  await page.getByLabel('Next id').fill('');
  await page.locator('#slide-s-1').focus();
  await page.keyboard.press('?');
  const dlg = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dlg).toBeVisible();
  for (const k of ['Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+C', 'Ctrl+V', 'Ctrl+D', 'Ctrl+A', 'Shift+Click', 'Escape', '?']) await expect(dlg.locator('dt', { hasText: k }).first()).toBeVisible();
  await expect(dlg).toContainText('Duplicate the selected objects');
  await shot(page, 'shortcuts');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await page.getByRole('button', { name: 'Keyboard shortcuts (?)' }).click();
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Close' }).click();
  await expect(dlg).toBeHidden();
});

test('import a Storyline file from the course picker: same importer as cf import / MCP / HTTP (parity)', async ({ page }) => {
  fs.mkdirSync(path.join(root, 'imports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'imports', 'synthetic.story'), pkg());
  await page.goto(`${base}/?token=${TOKEN}`);
  await page.getByLabel('Import format', { exact: true }).selectOption('json');
  await page.getByLabel('Path of the .story file in the courses folder').fill('imports/missing.story');
  await page.getByLabel('Name of the imported course').fill('imported-x');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('alert').first()).toContainText(/path/i);
  await page.getByLabel('Path of the .story file in the courses folder').fill('imports/synthetic.story');
  await page.getByLabel('Name of the imported course').fill('imported');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page).toHaveURL(/#imported$/);
  await expect(page.getByText(/not mapped are listed in/)).toBeVisible();
  expect(fs.existsSync(fileOf('imported'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'imported.import-report.json'))).toBe(true);
  await shot(page, 'import');
});

test('choose files instead of typing paths: a .story to import and an image to insert (FR-B1)', async ({ page }) => {
  await page.goto(`${base}/?token=${TOKEN}`);
  await page.getByLabel('Import format', { exact: true }).selectOption('json');
  await page.locator('input[type=file][aria-label="Storyline file: choose a file"]').setInputFiles({ name: 'My Module 1.story', mimeType: 'application/octet-stream', buffer: pkg() });
  await expect(page.locator('#imp-path')).toHaveValue('imports/my-module-1.story');
  await expect(page.locator('#imp-name')).toHaveValue('my-module-1');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page).toHaveURL(/#my-module-1$/);
  expect(fs.existsSync(path.join(root, 'imports', 'my-module-1.story'))).toBe(true);

  await page.getByRole('button', { name: 'Insert image (registers an asset)' }).click();
  const dialog = page.getByRole('dialog');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await dialog.locator('input[type=file]').setInputFiles({ name: 'Team Photo.PNG', mimeType: 'image/png', buffer: png });
  await expect(dialog.getByLabel('Image path', { exact: true })).toHaveValue('assets/team-photo.png');
  await dialog.getByLabel(/^Alt text/).fill('The team');
  await dialog.getByRole('button', { name: 'Insert image', exact: true }).click();
  await idle(page);
  const doc = io.loadCourse(fileOf('my-module-1'));
  expect(doc.assets.some((a) => a.path === 'assets/team-photo.png' && a.alt === 'The team')).toBe(true);
  expect(fs.readFileSync(path.join(root, 'assets', 'team-photo.png'))).toEqual(png);
});

test('native .story default: create, edit, undo, reopen, import and agent commands keep the native file', async ({ page }) => {
  await page.goto(`${base}/?token=${TOKEN}`);
  await expect(page.getByLabel('File format', { exact: true })).toHaveValue('story');
  await page.getByLabel('Lessons', { exact: true }).check();
  await expect(page.getByLabel('File format', { exact: true })).toHaveValue('json');
  await expect(page.getByLabel('File format', { exact: true })).toBeDisabled();
  await page.getByLabel('Slides', { exact: true }).check();
  await expect(page.getByLabel('File format', { exact: true })).toHaveValue('story');
  await page.getByLabel('File name', { exact: true }).fill('native');
  await page.getByLabel('Course title', { exact: true }).fill('Native Course');
  await page.getByRole('button', { name: 'Create course', exact: true }).click();
  await expect(page.locator('#course-file')).toHaveText('native.story');
  const file = path.join(root, 'native.story');
  expect(io.loadCourse(file).slides).toHaveLength(1);
  await page.getByRole('tab', { name: 'Course', exact: true }).click();
  await commit(page.locator('#c-title'), 'Edited Native');
  await expect(page.locator('#course-title')).toHaveText('Edited Native');
  await page.locator('#btn-agent').click();
  await expect(page.getByRole('dialog')).toContainText('native.story');
  await expect(page.getByRole('dialog')).not.toContainText('native.course.json');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#btn-undo').click();
  await expect(page.locator('#course-title')).toHaveText('Native Course');
  await page.locator('#btn-redo').click();
  await expect(page.locator('#course-title')).toHaveText('Edited Native');
  await page.getByRole('button', { name: 'Courses', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edited Native native.story', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edited Native native.story', exact: true }).click();
  await expect(page.locator('#course-file')).toHaveText('native.story');
  await page.getByRole('button', { name: 'Courses', exact: true }).click();
  await page.getByLabel('Path of the .story file in the courses folder').fill('native.story');
  await page.getByLabel('Name of the imported course').fill('native-copy');
  await expect(page.getByLabel('Import format', { exact: true })).toHaveValue('story');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('#course-file')).toHaveText('native-copy.story');
  expect(fs.readFileSync(path.join(root, 'native-copy.story'))).toEqual(fs.readFileSync(file));
  await shot(page, 'native-story');
});

test('course check lists a11y issues with their fix command and Go to selects the object (P1.7)', async ({ page }) => {
  seed('check', 'Check', [
    { cmd: 'slide.add', args: { id: 's-1', title: 'One', objects: [{ id: 'o-hot', type: 'hotspot', x: 10, y: 10, w: 100, h: 100 }] } },
  ]);
  await page.goto(`${base}/?token=${TOKEN}#check`);
  await page.getByRole('button', { name: 'Check' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText(/hotspot o-hot has no accessible name/);
  await expect(dlg).toContainText('object.set {"id":"o-hot","alt":');
  await shot(page, 'check');
  await dlg.getByRole('button', { name: /Go to \/slides\/0\/objects\/0/ }).click();
  await expect(page.locator('#obj-o-hot')).toHaveAttribute('aria-pressed', 'true');
});

test('reusable slide: Export downloads a package; Insert from file adds it with fresh ids (P1.4)', async ({ page }) => {
  seed('reuse', 'Reuse', [
    { cmd: 'var.add', args: { name: 'seen', type: 'boolean' } },
    { cmd: 'slide.add', args: { id: 's-card', title: 'Card', objects: [{ id: 'o-b', type: 'button', text: 'Flip %seen%' }] } },
    { cmd: 'trigger.add', args: { slide: 's-card', on: { event: 'click', target: 'o-b' }, do: [{ action: 'setVar', var: 'seen', op: 'toggle' }] } },
  ]);
  await page.goto(`${base}/?token=${TOKEN}#reuse`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export slide as a reusable file' }).click()]);
  const file = path.join(root, 'card.slide.json');
  await download.saveAs(file);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).kind).toBe('cf.slide/1');
  await page.locator('#import-slide-file').setInputFiles(file);
  await expect(page.getByText('Inserted the reusable slide.')).toBeVisible();
  await expect.poll(() => io.loadCourse(fileOf('reuse')).slides.length).toBe(2);
  const doc = io.loadCourse(fileOf('reuse'));
  expect(new Set(doc.slides.flatMap((s) => s.objects.map((o) => o.id))).size).toBe(2);
});

test('native Add results keeps the existing completion criterion and tracks the new quiz', async ({ page }) => {
  const file = path.join(root, 'native-results.story');
  io.saveCourse(file, emptyCourse({ title: 'Native results' }));
  const slide = io.loadCourse(file).slides[0].id;
  const result = io.runCommands(file, [
    { cmd: 'question.set', args: { slide, type: 'mc', prompt: 'Ready?', choices: [{ id: 'ready', label: 'Ready', correct: true }, { id: 'wait', label: 'Wait', correct: false }] } },
    { cmd: 'quiz.add', args: { id: 'q-ready', title: 'Readiness', questions: [slide] } },
  ]);
  expect(result.ok).toBe(true);
  await open(page, 'native-results', 'Native results');
  await page.getByRole('tab', { name: 'Course', exact: true }).click();
  await page.getByRole('button', { name: /^Add a results slide for Readiness/ }).click();
  await idle(page);
  const saved = io.loadCourse(file);
  expect(saved.quizzes[0].results).toBeTruthy();
  expect(saved.tracking.complete).toEqual([{ slidesViewed: 100 }, { quiz: 'q-ready' }]);
  await page.reload(); await idle(page);
  await page.getByRole('tab', { name: 'Course', exact: true }).click();
  await expect(page.getByLabel('Use result: Readiness')).toBeChecked();
});

test('tracking edits preserve exact slide counts and independent quiz alternatives', async ({ page }) => {
  seed('tracking-options', 'Tracking options', [
    { cmd: 'slide.add', args: { id: 's-one', title: 'One' } },
    { cmd: 'quiz.add', args: { id: 'q-one', title: 'First check' } },
    { cmd: 'quiz.add', args: { id: 'q-two', title: 'Second check' } },
    { cmd: 'tracking.set', args: { complete: [{ slidesViewedCount: 26 }, { quiz: 'q-one' }, { quiz: 'q-two' }] } },
  ]);
  await open(page, 'tracking-options', 'Tracking options');
  await page.getByRole('tab', { name: 'Course', exact: true }).click();
  await expect(page.getByLabel('Number of slides viewed', { exact: true })).toHaveValue('26');
  await expect(page.getByLabel('Use result: First check')).toBeChecked();
  await expect(page.getByLabel('Use result: Second check')).toBeChecked();
  await commit(page.getByLabel('Number of slides viewed', { exact: true }), 25);
  expect(io.loadCourse(fileOf('tracking-options')).tracking.complete).toEqual([{ slidesViewedCount: 25 }, { quiz: 'q-one' }, { quiz: 'q-two' }]);
  await page.getByLabel('Use result: First check').uncheck(); await idle(page);
  expect(io.loadCourse(fileOf('tracking-options')).tracking.complete).toEqual([{ slidesViewedCount: 25 }, { quiz: 'q-two' }]);
  await page.reload(); await idle(page);
  await page.getByRole('tab', { name: 'Course', exact: true }).click();
  await expect(page.getByLabel('Number of slides viewed', { exact: true })).toHaveValue('25');
  await expect(page.getByLabel('Use result: Second check')).toBeChecked();
});

test('a window narrower than 1024 px keeps the editor usable: it scrolls sideways and says so (FR-B3)', async ({ page }) => {
  seed('narrow', 'Narrow', [{ cmd: 'slide.add', args: { id: 's-1', title: 'One' } }]);
  await page.setViewportSize({ width: 900, height: 700 });
  await open(page, 'narrow', 'Narrow');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.narrow')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish SCORM 1.2' })).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeGreaterThanOrEqual(1024);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.narrow')).toBeHidden();
});
