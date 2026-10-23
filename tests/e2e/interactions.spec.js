// in the published player: slider, dial (pointer + keyboard). Web package from file:// and 127.0.0.1
// every non-local request is aborted and must never be attempted.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { publishWeb, validatePackage } from '../../packages/publisher/index.js';
import { createServer } from '../../packages/lms-test-harness/serve.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, '.tmp');

function buildCourse() {
  const r = applyAll(emptyCourse({ id: 'ix-e2e', title: 'Interactions E2E' }), [
    { cmd: 'var.add', args: { name: 'level', type: 'number', initial: 0 } },
    { cmd: 'var.add', args: { name: 'calm', type: 'number', initial: 0 } },
    { cmd: 'var.add', args: { name: 'turn', type: 'number', initial: 6 } },
    { cmd: 'slide.add', args: { id: 's-range', title: 'Slider and dial', objects: [
      { id: 'o-sl', type: 'slider', var: 'level', name: 'Level', x: 80, y: 120, w: 600, h: 48 },
      { id: 'o-calm', type: 'slider', var: 'calm', name: 'Calm', live: false, x: 80, y: 220, w: 600, h: 48 },
      { id: 'o-dl', type: 'dial', var: 'turn', name: 'Volume', x: 860, y: 100, w: 240, h: 240 },
      { id: 'o-out', type: 'text', x: 80, y: 400, w: 1000, h: 60, text: 'L=%level% C=%calm% T=%turn%', style: { fontSize: 36 } },
    ] } },
    { cmd: 'slide.add', args: { id: 's-hs', title: 'Hotspot', objects: [ // the "picture": shapes standing in for an image object
      { id: 'o-tank', type: 'shape', shape: 'rounded', x: 200, y: 200, w: 300, h: 400, text: 'Tank', style: { fill: '#c9d6e8' } },
      { id: 'o-valve', type: 'shape', shape: 'ellipse', x: 760, y: 300, w: 200, h: 150, text: 'Valve', style: { fill: '#f0b429' } },
    ], question: { type: 'hotspot', prompt: 'Click the valve', attempts: 2, areas: [
      { id: 'valve', shape: 'ellipse', x: 760, y: 300, w: 200, h: 150, correct: true }, { id: 'tank', x: 200, y: 200, w: 300, h: 400 },
    ] } } },
    { cmd: 'slide.add', args: { id: 's-done', title: 'Done' } },
    { cmd: 'slide.add', args: { id: 's-dd', title: 'Sort the waste', objects: [
      { id: 'o-sharps', type: 'shape', x: 120, y: 380, w: 360, h: 260, text: 'Sharps bin', style: { fill: '#f6d5d5', valign: 'top' } },
      { id: 'o-bio', type: 'shape', x: 760, y: 380, w: 360, h: 260, text: 'Biohazard bag', style: { fill: '#d8ecd9', valign: 'top' } },
      { id: 'o-glass', type: 'shape', x: 120, y: 140, w: 200, h: 56, text: 'Glass', style: { fill: '#ffffff', border: '#6b7080', borderWidth: 2 } },
      { id: 'o-gloves', type: 'shape', x: 360, y: 140, w: 200, h: 56, text: 'Gloves', style: { fill: '#ffffff', border: '#6b7080', borderWidth: 2 } },
      { id: 'o-tube', type: 'shape', x: 600, y: 140, w: 200, h: 56, text: 'Tube', style: { fill: '#ffffff', border: '#6b7080', borderWidth: 2 } },
      { id: 'o-paper', type: 'shape', x: 840, y: 140, w: 200, h: 56, text: 'Paper', style: { fill: '#ffffff', border: '#6b7080', borderWidth: 2 } },
    ], question: { type: 'dragdrop', prompt: 'Drag each item into its container', items: [
      { object: 'o-glass', target: 'o-sharps' }, { object: 'o-gloves', target: 'o-bio' }, { object: 'o-tube', target: 'o-bio' }, { object: 'o-paper' },
    ], targets: [{ object: 'o-sharps' }, { object: 'o-bio', capacity: 'many' }] } } },
    { cmd: 'slide.add', args: { id: 's-match', title: 'Match', question: { type: 'matching', prompt: 'Match each sample to its sign', choices: [{ id: 'bio', label: 'Biohazard' }, { id: 'rad', label: 'Radiation' }, { id: 'fire', label: 'Flammable' }],
      rows: [{ id: 'blood', label: 'Blood', choice: 'bio' }, { id: 'urine', label: 'Urine', choice: 'bio' }, { id: 'iso', label: 'Isotope', choice: 'rad' }] } } },
    { cmd: 'slide.add', args: { id: 's-seq', title: 'Order', question: { type: 'sequence', prompt: 'Put the steps in order', choices: [{ id: 'wash', label: 'Wash hands' }, { id: 'gown', label: 'Put on gown' }, { id: 'gloves', label: 'Put on gloves' }, { id: 'work', label: 'Start work' }] } } },
    { cmd: 'slide.add', args: { id: 's-mk', title: 'Lab tour', objects: [
      { id: 'o-room', type: 'shape', x: 80, y: 80, w: 1120, h: 560, text: 'Lab floor plan', style: { fill: '#eef2f7' } },
      { id: 'o-mk-hood', type: 'marker', text: 'Fume hood', detail: 'Keep the sash below the marked line.', x: 300, y: 260, w: 48, h: 48 },
      { id: 'o-mk-wash', type: 'marker', text: 'Eyewash', detail: 'Flush for 15 minutes.', x: 1000, y: 300, w: 48, h: 48 },
    ] } },
  ]);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
}

// The first slide autoplays a captioned video, so the player starts behind a click-to-start overlay.
function mediaCourse() {
  const r = applyAll(emptyCourse({ id: 'ix-media', title: 'Media E2E' }), [
    { cmd: 'player.set', args: { menu: false } },
    { cmd: 'var.add', args: { name: 'ends', type: 'number', initial: 0 } },
    { cmd: 'asset.add', args: { id: 'a-clip', path: 'assets/clip.mp4', alt: 'Synthetic test pattern' } },
    { cmd: 'asset.add', args: { id: 'a-cc', path: 'assets/clip.vtt' } },
    { cmd: 'asset.add', args: { id: 'a-tone', path: 'assets/tone.wav' } },
    { cmd: 'slide.add', args: { id: 's-vid', title: 'Video', objects: [
      { id: 'o-vid', type: 'video', media: 'a-clip', captions: 'a-cc', autoplay: true, controls: false, x: 160, y: 60, w: 960, h: 540 },
      { id: 'o-ends', type: 'text', x: 160, y: 620, w: 600, h: 50, text: 'Ends: %ends%' },
    ] } },
    { cmd: 'trigger.add', args: { slide: 's-vid', on: { event: 'mediaEnd', target: 'o-vid' }, do: [{ action: 'setVar', var: 'ends', op: 'add', value: 1 }] } },
    { cmd: 'slide.add', args: { id: 's-aud', title: 'Audio', objects: [
      { id: 'o-aud', type: 'audio', media: 'a-tone', alt: 'Tone', x: 160, y: 200, w: 400, h: 54 },
      { id: 'o-play', type: 'button', text: 'Play tone', x: 160, y: 300, w: 240, h: 60 },
      { id: 'o-stop', type: 'button', text: 'Stop tone', x: 420, y: 300, w: 240, h: 60 },
    ] } },
    { cmd: 'trigger.add', args: { slide: 's-aud', on: { event: 'click', target: 'o-play' }, do: [{ action: 'playMedia', target: 'o-aud' }] } },
    { cmd: 'trigger.add', args: { slide: 's-aud', on: { event: 'click', target: 'o-stop' }, do: [{ action: 'stopMedia', target: 'o-aud' }] } },
  ]);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
}

let webDir, webUrl, mediaDir, mediaUrl;
const servers = [];
async function serve(dir) {
  const s = createServer(dir);
  await new Promise((res) => s.listen(0, '127.0.0.1', res));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
test.beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ix-'));
  const courseDir = path.join(base, 'course');
  fs.mkdirSync(path.join(courseDir, 'assets'), { recursive: true });
  const FIX = path.join(ROOT, 'tests/fixtures/synthetic');
  fs.copyFileSync(path.join(FIX, 'clip-2s.mp4'), path.join(courseDir, 'assets/clip.mp4'));
  fs.copyFileSync(path.join(FIX, 'captions-2s.vtt'), path.join(courseDir, 'assets/clip.vtt'));
  fs.copyFileSync(path.join(FIX, 'tone-440hz-2s.wav'), path.join(courseDir, 'assets/tone.wav'));
  webDir = path.join(base, 'web');
  mediaDir = path.join(base, 'media');
  publishWeb(buildCourse(), webDir, { courseDir });
  publishWeb(mediaCourse(), mediaDir, { courseDir });
  expect(validatePackage(webDir)).toEqual([]);
  expect(validatePackage(mediaDir)).toEqual([]);
  webUrl = await serve(webDir);
  mediaUrl = await serve(mediaDir);
  fs.mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => { for (const s of servers) await new Promise((res) => s.close(res)); });

let requests, errors;
test.beforeEach(async ({ context, page }) => {
  await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => r.abort());
  requests = [];
  errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
});
test.afterEach(async () => {
  expect(requests.filter((u) => !/^(file:|data:|blob:|http:\/\/127\.0\.0\.1[:/])/.test(u)), 'non-local requests').toEqual([]);
  expect(errors, 'page/console errors').toEqual([]);
});

// The menu is the way past unanswered question slides (Next waits for an answer there).
const goSlide = (page, title) => page.getByRole('navigation', { name: 'Course menu' }).getByRole('button', { name: new RegExp('^' + title) }).click();
const origins = { 'file://': () => pathToFileURL(path.join(webDir, 'index.html')).href, '127.0.0.1': () => `${webUrl}/index.html` };
const mediaOrigins = { 'file://': () => pathToFileURL(path.join(mediaDir, 'index.html')).href, '127.0.0.1': () => `${mediaUrl}/index.html` };

for (const [name, url] of Object.entries(origins)) {
  test(`slider and dial from ${name}: keyboard, live drag, release-only drag, dial pointer`, async ({ page }) => {
    await page.goto(url());
    const out = page.getByText(/^L=/);
    await expect(out).toHaveText('L=0 C=0 T=6');
    const level = page.getByRole('slider', { name: 'Level range from 0 to 10' });
    await level.focus();
    for (const [key, want] of [['ArrowRight', 1], ['ArrowRight', 2], ['ArrowUp', 3], ['End', 10], ['Home', 0], ['PageUp', 1]]) {
      await page.keyboard.press(key);
      await expect(out).toHaveText(`L=${want} C=0 T=6`);
    }
    // Live drag: the variable follows the thumb before the button is released.
    const box = await level.boundingBox();
    await page.mouse.move(box.x + 2 + box.width * 0.1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 8 });
    await expect(out).toHaveText('L=5 C=0 T=6');
    await page.mouse.move(box.x + box.width * 0.79, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(out).toHaveText('L=8 C=0 T=6');

    // live:false updates on release only.
    const calm = page.getByRole('slider', { name: 'Calm range from 0 to 10' });
    const cb = await calm.boundingBox();
    await page.mouse.move(cb.x + 3, cb.y + cb.height / 2);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.width * 0.7, cb.y + cb.height / 2, { steps: 8 });
    await expect(out).toHaveText('L=8 C=0 T=6');
    await page.mouse.up();
    await expect(out).toHaveText(/^L=8 C=7 T=6$/);

    // Dial: keyboard like the slider (from 6, ArrowRight 7, 8, ArrowLeft 7, ArrowDown 6, End 12, Home 0).
    const dial = page.getByRole('slider', { name: 'Volume range from 0 to 12' });
    await dial.focus();
    for (const [key, want] of [['ArrowRight', 7], ['ArrowRight', 8], ['ArrowLeft', 7], ['ArrowDown', 6], ['End', 12], ['Home', 0]]) {
      await page.keyboard.press(key);
      await expect(out).toHaveText(`L=8 C=7 T=${want}`);
    }
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'ix-range.png'), animations: 'disabled' });
    // Pointer: 12 o'clock is the middle of -90..90, 3 o'clock the end, 9 o'clock the start.
    const face = page.locator('.cf-dial');
    const db = await face.boundingBox();
    const cx = db.x + db.width / 2, cy = db.y + db.height / 2;
    await page.mouse.click(cx, db.y + 8);
    await expect(out).toHaveText('L=8 C=7 T=6');
    await page.mouse.click(db.x + db.width - 8, cy);
    await expect(out).toHaveText('L=8 C=7 T=12');
    await page.mouse.move(db.x + db.width - 8, cy);
    await page.mouse.down();
    await page.mouse.move(db.x + 8, cy + 2, { steps: 12 }); // drag round the top to 9 o'clock
    await page.mouse.up();
    await expect(out).toHaveText('L=8 C=7 T=0');
    await expect(dial).toBeFocused(); // a pointer turn focuses the dial's range control
    const angle = await page.locator('.cf-dial-pointer').evaluate((el) => el.style.transform);
    expect(angle).toBe('rotate(-90deg)');
  });

  test(`hotspot question from ${name}: pointer miss, try again keeps the marker, keyboard marker hit`, async ({ page }) => {
    await page.goto(url());
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Click the valve')).toBeVisible();
    const submit = page.getByRole('button', { name: 'Submit' });
    await expect(submit).toBeDisabled(); // no click yet: nothing to submit
    const surface = page.getByRole('application', { name: /Answer area/ });
    const tank = await page.locator('[data-id="o-tank"]').boundingBox();
    await surface.click({ position: { x: tank.x - (await surface.boundingBox()).x + tank.width / 2, y: tank.y - (await surface.boundingBox()).y + tank.height / 2 } });
    await expect(page.locator('.cf-hs-marker')).toBeVisible();
    await submit.click();
    const again = page.getByRole('dialog', { name: 'Try again' });
    await expect(again).toBeVisible();
    await again.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.cf-hs-marker')).toBeVisible(); // Try Again keeps the answer
    // Keyboard: the marker continues from the last point (the tank centre, about 350,400); Shift+Right x10 = +500,
    // inside the valve ellipse (760..960 x 300..450).
    const pos = () => page.locator('.cf-hs-marker').evaluate((el) => [parseFloat(el.style.left), parseFloat(el.style.top)]);
    const [x0, y0] = await pos();
    expect(Math.abs(x0 - 350)).toBeLessThan(3);
    await surface.focus();
    for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'ix-hotspot.png'), animations: 'disabled' });
    expect(await pos()).toEqual([x0 + 490, y0]);
    await submit.click();
    await expect(page.getByRole('dialog', { name: 'Correct' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.cf-slide-title')).toHaveText('Done');
  });

  test(`drag and drop from ${name}: pointer drags (replace, stack), keyboard pick-up and drop, Escape, grading`, async ({ page }) => {
    await page.goto(url());
    await goSlide(page, 'Sort the waste');
    await expect(page.getByText('Drag each item into its container')).toBeVisible();
    const submit = page.getByRole('button', { name: 'Submit' });
    await expect(submit).toBeDisabled(); // nothing moved yet (guard)
    const box = (oid) => page.locator(`[data-id="${oid}"]`).boundingBox();
    async function drag(from, to) {
      const a = await box(from), b = await box(to);
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
      await page.mouse.up();
    }
    const paperHome = await box('o-paper');
    await drag('o-paper', 'o-sharps');
    await expect(page.getByRole('button', { name: 'Paper, on Sharps bin' })).toBeVisible();
    await expect(submit).toBeEnabled();
    await drag('o-glass', 'o-sharps'); // replaces Paper, which goes back to its own start
    await expect(page.getByRole('button', { name: 'Glass, on Sharps bin' })).toBeVisible();
    await expect.poll(async () => { const p = await box('o-paper'); return [Math.round(p.x), Math.round(p.y)]; }).toEqual([Math.round(paperHome.x), Math.round(paperHome.y)]);
    const g = await box('o-glass'), s = await box('o-sharps');
    expect(Math.abs(g.x + g.width / 2 - (s.x + s.width / 2))).toBeLessThan(2); // centred on the one-item target

    // Keyboard: Enter picks Gloves up, Enter on the bag drops it; Space + Escape cancels; then Tube goes in too.
    const gloves = page.getByRole('button', { name: /^Gloves/ });
    await gloves.focus();
    await page.keyboard.press('Enter');
    await expect(gloves).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/Picked up Gloves/)).toBeAttached();
    const bag = page.getByRole('button', { name: 'Drop target: Biohazard bag' });
    await bag.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Gloves, on Biohazard bag' })).toBeVisible();
    await expect(page.getByText('Gloves placed on Biohazard bag.')).toBeAttached();
    const tube = page.getByRole('button', { name: /^Tube/ });
    await tube.focus();
    await page.keyboard.press('Space');
    await expect(tube).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(tube).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Space');
    await bag.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Tube, on Biohazard bag' })).toBeVisible();
    const gl = await box('o-gloves'), tb = await box('o-tube');
    expect(tb.y).toBeGreaterThan(gl.y + gl.height - 1); // stacked under Gloves
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'ix-dragdrop.png'), animations: 'disabled' });
    await submit.click();
    await expect(page.getByRole('dialog', { name: 'Correct' })).toBeVisible();
  });

  test(`matching and sequence from ${name}: a drop-down per row (every row needed), reorder by drag and by keyboard`, async ({ page }) => {
    await page.goto(url());
    await goSlide(page, 'Match');
    await expect(page.getByRole('group', { name: 'Match each sample to its sign' })).toBeVisible();
    const submit = page.getByRole('button', { name: 'Submit' });
    await page.getByLabel('Blood').selectOption('bio');
    await page.getByLabel('Urine').selectOption('bio'); // the same choice twice is allowed
    await expect(submit).toBeDisabled(); // every row needs a choice
    await page.getByLabel('Isotope').focus();
    await page.getByLabel('Isotope').selectOption('rad');
    await expect(submit).toBeEnabled();
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'ix-matching.png'), animations: 'disabled' });
    await submit.click();
    await page.getByRole('dialog', { name: 'Correct' }).getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('group', { name: 'Put the steps in order' })).toBeVisible();
    const items = page.locator('.cf-seq-item');
    const order = () => items.evaluateAll((els) => els.map((e) => e.dataset.choice));
    const start = await order();
    // Pointer: drop the last row on the top half of the first row: it is inserted first, the others shift (Q3).
    const last = await items.nth(3).boundingBox(), top = await items.nth(0).boundingBox();
    await page.mouse.move(last.x + 40, last.y + last.height / 2);
    await page.mouse.down();
    await page.mouse.move(top.x + 40, top.y + 4, { steps: 10 });
    await page.mouse.up();
    await expect.poll(order).toEqual([start[3], start[0], start[1], start[2]]);
    // Keyboard: Move up/down buttons; focus stays on the moved row.
    const want = ['wash', 'gown', 'gloves', 'work'];
    const label = { wash: 'Wash hands', gown: 'Put on gown', gloves: 'Put on gloves', work: 'Start work' };
    const down = page.getByRole('button', { name: `Move ${label[start[3]]} down` });
    await down.focus();
    await page.keyboard.press('Space');
    await expect.poll(order).toEqual([start[0], start[3], start[1], start[2]]);
    await expect(down).toBeFocused();
    await expect(page.getByText(`${label[start[3]]}, position 2`)).toBeAttached();
    for (const [i, id] of want.entries()) {
      for (let guard = 0; guard < 4 && (await order()).indexOf(id) > i; guard++) {
        const up = page.getByRole('button', { name: `Move ${label[id]} up` });
        await up.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.cf-seq-item').filter({ has: page.locator(':focus') })).toHaveAttribute('data-choice', id);
      }
    }
    expect(await order()).toEqual(want);
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'ix-sequence.png'), animations: 'disabled' });
    await submit.click();
    await expect(page.getByRole('dialog', { name: 'Correct' })).toBeVisible();
  });

  test(`markers from ${name}: click toggles, one open at a time, blank click closes, focus opens, Escape closes`, async ({ page }) => {
    await page.goto(url());
    await goSlide(page, 'Lab tour');
    const hood = page.getByRole('button', { name: 'Fume hood' }), wash = page.getByRole('button', { name: 'Eyewash' });
    const hoodLabel = page.getByText('Keep the sash below the marked line.'), washLabel = page.getByText('Flush for 15 minutes.');
    await expect(hood).toHaveAttribute('aria-expanded', 'false');
    await expect(hoodLabel).toBeHidden();
    await hood.click();
    await expect(hood).toHaveAttribute('aria-expanded', 'true');
    await expect(hoodLabel).toBeVisible();
    await hood.click(); // a second click closes it
    await expect(hoodLabel).toBeHidden();
    await hood.click();
    await wash.click(); // opening another marker closes the first
    await expect(hoodLabel).toBeHidden();
    await expect(washLabel).toBeVisible();
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'ix-marker.png'), animations: 'disabled' });
    await page.mouse.click(200, 650); // blank slide area
    await expect(washLabel).toBeHidden();
    // Keyboard: focus opens, Escape closes (focus stays), Enter toggles, moving on closes.
    await hood.focus();
    await expect(hoodLabel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(hoodLabel).toBeHidden();
    await expect(hood).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(hoodLabel).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(wash).toBeFocused();
    await expect(hoodLabel).toBeHidden();
    await expect(washLabel).toBeVisible();
    await expect(wash).toHaveAttribute('aria-controls', /-mk-o-mk-wash$/);
  });

  test(`video and audio from ${name}: start overlay, autoplay, captions off then CC/Ctrl+Alt+C, mediaEnd, click toggle, media actions`, async ({ page }) => {
    await page.goto(mediaOrigins[name]());
    const go = page.getByRole('button', { name: 'Start course' });
    await expect(go).toBeFocused(); // nothing plays and the timeline waits until the click
    await expect(page.locator('video')).toHaveCount(0);
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'ix-start-overlay.png'), animations: 'disabled' });
    await go.click();
    const video = page.getByRole('button', { name: 'Synthetic test pattern, play or pause' });
    await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 15000 }).toBeGreaterThan(0.2); // autoplayed (slow when workers share the CPU)
    const track = () => video.evaluate((v) => ({ mode: v.textTracks[0].mode, cues: v.textTracks[0].cues ? v.textTracks[0].cues.length : -1, kind: v.textTracks[0].kind }));
    await expect.poll(track).toEqual({ mode: 'hidden', cues: 2, kind: 'captions' }); // loaded (blob track on file:// too), off by default
    const cc = page.getByRole('button', { name: 'Captions' });
    await expect(cc).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Control+Alt+KeyC');
    await expect(cc).toHaveAttribute('aria-pressed', 'true');
    expect((await track()).mode).toBe('showing');
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'ix-video-captions.png'), animations: 'disabled' });
    await expect(page.getByText('Ends: 1')).toBeVisible({ timeout: 15000 }); // mediaEnd trigger
    await cc.click();
    expect((await track()).mode).toBe('hidden');
    await video.click(); // no native controls: a click toggles playback
    await expect.poll(() => video.evaluate((v) => v.paused)).toBe(false);
    await video.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => video.evaluate((v) => v.paused)).toBe(true);

    await page.getByRole('button', { name: 'Next' }).click();
    const audio = page.locator('audio');
    await expect(audio).toHaveAttribute('controls', '');
    await expect(audio).toHaveAttribute('aria-label', 'Tone');
    await expect(cc).toBeHidden(); // no captioned media on this slide
    await page.getByRole('button', { name: 'Play tone' }).click();
    await expect.poll(() => audio.evaluate((a) => a.currentTime), { timeout: 15000 }).toBeGreaterThan(0.2);
    await page.getByRole('button', { name: 'Stop tone' }).click();
    await expect.poll(() => audio.evaluate((a) => [a.paused, a.currentTime])).toEqual([true, 0]);
  });
}
