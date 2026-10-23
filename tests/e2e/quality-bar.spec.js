// Q8: all course creation/editing uses visible editor controls. Filesystem writes only provide an original
// image, like a designer placing an image in the courses folder. Saved documents are read only for assertions.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../../packages/server/server.js';
import { createServer as staticServer } from '../../packages/lms-test-harness/serve.js';
import { validate } from '../../packages/schema/index.js';
import { validatePackage } from '../../packages/publisher/index.js';

const TOKEN = 'quality-bar-local-test-token';
test.use({ actionTimeout: 30000 }); // long UI-only authoring runs beside the rest of the suite
const TITLE = 'Clear handoffs: a practice workshop';
// Original instruction, with explicit reflection exercises. Estimated learner duration: 15–20 minutes;
// automation checks the workflow and interactions, not how long a real person takes to learn.
const TOPICS = [
  ['A handoff is a promise', 'In this 18-minute workshop, practise giving another person enough context to continue your work. A useful handoff names the outcome, current state, next action and owner. Think of a task that stalled when someone was away. Spend one minute recalling what information would have helped.'],
  ['Start with the outcome', 'Describe what success looks like before listing activities. “A visitor can find the right room” is clearer than “update signs”. The next person can then make sensible choices when the plan changes. Practice for 45 seconds: rewrite the goal of your current task as an outcome someone else can observe.'],
  ['Separate done from planned', 'State what is complete, what is underway and what has not started. A checklist labelled only “work” makes readers guess. Use a short status sentence for each item. Practice for 45 seconds: divide a recent task into these three groups and identify one thing you initially assumed was finished.'],
  ['Make the next action concrete', 'The next action should be small enough to start immediately. “Handle the event” is vague. “Call the venue to confirm the room capacity” names an action and purpose. Spend one minute writing the next action for a real task. Check that it begins with a verb and names the needed input.'],
  ['Name one accountable owner', 'A team can help, but someone must know they are carrying the next step. “Operations will do it” can leave everyone waiting. Name an owner and ask them to acknowledge the handoff. Reflection: when would you need a backup owner? Write a backup route for your example without assigning the same task twice.'],
  ['Explain the decision', 'Record the reason for a choice, especially when a tempting alternative was rejected. A brief reason prevents the next person from repeating the investigation. Practice: imagine two rooms are available but only one has step-free access. Write a sentence explaining the choice without copying a whole meeting transcript.'],
  ['Link the working material', 'Point to the current working file and name its purpose. Avoid unexplained attachments or several files all called final. Check that the recipient can access the location. For one minute, sketch a three-item resource list: the working draft, the decision record and the contact needed for questions.'],
  ['Describe uncertainty honestly', 'A handoff can be useful even when an answer is unknown. State the uncertainty and how to resolve it. “Room capacity awaiting confirmation from the venue” is actionable. Practice for 45 seconds: replace a vague warning such as “there may be issues” with a specific unknown and a verification step.'],
  ['Give deadlines context', 'Distinguish the next checkpoint from the final deadline. Explain dependencies: printing cannot start until the room assignment is approved. The recipient can then prioritise. Reflection for one minute: identify the earliest decision that could delay your example and set a checkpoint early enough to respond.'],
  ['Use the handoff map', 'Follow this sequence: owner, next action, acknowledgement. Follow it with your own example. Say aloud who acts, what they will do and how you will know they accepted the work. Spend one minute finding any missing link. A sent message alone does not establish shared understanding.'],
  ['Ask for a read-back', 'Invite the recipient to summarise the next action in their own words. This reveals mismatched assumptions without making the exchange an interrogation. Try: “What will you do first, and what do you need from me?” Practice both sides of that conversation for one minute, then revise one sentence in your handoff.'],
  ['Plan for an absent owner', 'If the named person is unavailable, use the agreed backup route. Do not silently transfer responsibility to a whole group. Record the change and confirm acceptance. Take one minute to decide what should happen if your example task has no response by its checkpoint. Make the escalation step specific.'],
  ['Keep the record current', 'After a change, update the same handoff record and explain what changed. Competing copies force the next person to reconcile history. Practice for 45 seconds: write a two-line update that replaces an old deadline, states the new checkpoint and preserves the reason for the change.'],
  ['Practise a complete handoff', 'Scenario: you arranged a workshop and are away tomorrow. The room is booked, signs are drafted and the attendee count is unconfirmed. Spend two minutes drafting a handoff with outcome, status, owner, next action, checkpoint and source links. Read it once as the recipient and circle anything that requires guessing.'],
  ['Check your readiness', 'Use this final minute to review your draft. Can someone identify the next action without asking you? Is the owner clear? Does the record separate confirmed facts from assumptions? Explain one change you made after the read-back exercise. The two questions next check the central ideas; a passing score is 80 percent.'],
];
const QUESTIONS = [
  ['What is the clearest next action?', 'Call the venue to confirm capacity', 'Sort out the workshop'],
  ['What confirms acceptance of a handoff?', 'The owner acknowledges the next step', 'The message was sent'],
];

const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');
async function edit(locator, value) { await locator.fill(String(value)); await locator.press('Tab'); await idle(locator.page()); }
async function choose(locator, value) { await locator.selectOption(value); await idle(locator.page()); }
async function click(page, name) { await page.getByRole('button', { name, exact: true }).click(); await idle(page); }
async function tab(page, name) { await page.getByRole('tab', { name, exact: true }).click(); }
async function nextId(page, id, lessons = false) { await page.locator(lessons ? '#lv-next-id' : '#next-id').fill(id); }

async function setup(page, context, info, mode) {
  fs.mkdirSync('.tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('.tmp', `quality-bar-${mode}-`));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/handoff.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="180" viewBox="0 0 900 180"><rect width="900" height="180" fill="#eef2f5"/><g font-family="sans-serif" font-size="26" fill="#173d47"><text x="40" y="98">Owner</text><text x="240" y="98">→ Next action</text><text x="540" y="98">→ Acknowledgement</text></g></svg>');
  const external = [], errors = [], servers = [];
  await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => { external.push(r.request().url()); return r.abort(); });
  page.on('pageerror', (e) => errors.push(e.message));
  const server = createServer({ root, token: TOKEN, port: 0 }); servers.push(server);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/?token=${TOKEN}`);
  await page.getByLabel(mode === 'lessons' ? 'Lessons' : 'Slides', { exact: true }).check();
  if (mode === 'slides') await page.getByLabel('File format', { exact: true }).selectOption('json');
  await page.getByLabel('File name').fill(mode);
  await page.getByLabel('Course title').fill(TITLE);
  await click(page, 'Create course');
  await expect(page.locator('#course-title')).toHaveText(TITLE);
  const saved = () => JSON.parse(fs.readFileSync(path.join(root, `${mode}.course.json`), 'utf8'));
  return { root, saved, external, errors, servers, async close() {
    await page.goto('about:blank'); // close the editor's event stream before stopping its server
    for (const s of servers) await new Promise((r) => { s.close(r); s.closeAllConnections(); });
  } };
}

async function reopenPreviewPublish(page, env, mode) {
  // Edits autosave. Confirm persisted content survives a full editor reload and opening via the picker.
  await idle(page);
  const before = env.saved();
  expect(validate(before)).toEqual([]);
  await page.reload(); await idle(page);
  await expect(page.locator('#course-title')).toHaveText(TITLE);
  expect(env.saved()).toEqual(before);
  await click(page, 'Courses');
  await page.getByRole('button', { name: new RegExp(TITLE) }).click(); await idle(page);
  await click(page, 'Preview');
  const frame = page.frameLocator('dialog iframe');
  if (mode === 'lessons') {
    await frame.getByRole('button', { name: 'Start course' }).click();
    await expect(frame.getByRole('heading', { name: 'Prepare a useful handoff', exact: true })).toBeVisible();
  } else {
    await expect(frame.locator('.cf-slide-title')).toHaveText(TOPICS[0][0]);
    await frame.getByRole('button', { name: 'Review example', exact: true }).click();
    await expect(frame.getByText('Example: Sam will confirm the room by noon.')).toBeVisible();
  }
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  for (const [button, target] of [['Publish Web', 'web'], ['Publish SCORM 1.2', 'scorm12']]) {
    await click(page, button);
    await expect(page.locator('.toast').filter({ hasText: /Published/ }).last()).toBeVisible();
    const dir = path.join(env.root, 'dist', `${mode}-${target}`);
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(true);
    expect(validatePackage(dir)).toEqual([]);
  }
}

async function playPackages(page, env, mode, play) {
  for (const target of ['web', 'scorm12']) {
    const server = staticServer(path.join(env.root, 'dist', `${mode}-${target}`)); env.servers.push(server);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await page.goto(`http://127.0.0.1:${server.address().port}/${target === 'web' ? '' : '__lms/'}`);
    const scope = target === 'web' ? page : page.frameLocator('#sco');
    await play(scope);
    if (target === 'web') {
      await expect.poll(() => page.evaluate((id) => JSON.parse(localStorage.getItem('cf:' + id))?.status, env.saved().id)).toBe('passed');
    } else {
      const log = await page.evaluate(() => window.__lmsLog);
      const sets = log.filter((e) => e.fn === 'LMSSetValue');
      expect(sets.filter((e) => e.ret !== 'true')).toEqual([]);
      for (const [key, value] of [['cmi.core.lesson_status', 'passed'], ['cmi.core.score.raw', '100']]) {
        expect(sets.some((e) => e.args[0] === key && e.args[1] === value), key).toBe(true);
      }
      expect(sets.filter((e) => /^cmi.interactions.\d+.result$/.test(e.args[0])).map((e) => e.args[1])).toEqual(['correct', 'correct']);
      const saves = sets.filter((e) => e.args[0] === 'cmi.suspend_data');
      expect(saves.length).toBeGreaterThan(0);
      expect(saves.every((e) => e.args[1].length <= 4096)).toBe(true);
    }
  }
  expect(env.external).toEqual([]);
  expect(env.errors).toEqual([]);
}

test('Q8 slides: author 18 slides, reopen, preview, publish and finish web + SCORM through the UI', async ({ page, context }, info) => {
  test.setTimeout(180000);
  const env = await setup(page, context, info, 'slides');
  try {
    for (let i = 0; i < TOPICS.length; i++) {
      await nextId(page, `s-${i + 1}`); await click(page, 'Add slide');
      await tab(page, 'Slide'); await edit(page.getByLabel('Slide title'), TOPICS[i][0]);
      await nextId(page, `body-${i + 1}`); await click(page, 'Insert text');
      await edit(page.getByLabel('Text (%name% shows a variable)'), TOPICS[i][1]);
      for (const [label, value] of [['X', 100], ['Y', 80], ['Width', 1080], ['Height', 410]]) await edit(page.getByLabel(label, { exact: true }), value);
    }
    await page.locator('#slide-s-10').click();
    await nextId(page, 'map');
    await page.getByRole('button', { name: 'Insert image (registers an asset)' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Image path', { exact: true }).fill('assets/handoff.svg');
    await dialog.getByLabel(/^Alt text/).fill('Owner leads to next action, then acknowledgement');
    await dialog.getByRole('button', { name: 'Insert image', exact: true }).click(); await idle(page);
    await edit(page.getByLabel('Y', { exact: true }), 510);
    await expect(page.locator('#obj-map img')).toBeVisible();

    await page.locator('#slide-s-1').click();
    await tab(page, 'Variables');
    await page.getByLabel('New variable name').fill('reviewed');
    await choose(page.getByLabel('New variable type'), 'boolean');
    await page.locator('button[data-cmd="var.add"]').click(); await idle(page);
    await nextId(page, 'review'); await click(page, 'Insert button');
    await edit(page.getByLabel('Text (%name% shows a variable)'), 'Review example');
    await edit(page.getByLabel('Y', { exact: true }), 600);
    await tab(page, 'States');
    await page.getByLabel('New state name').fill('selected'); await click(page, 'Add state');
    await edit(page.locator('#st-selected-fill'), '#b8ddcd');
    await tab(page, 'Layers');
    await page.getByLabel('Layer ID (optional)').fill('example');
    await page.locator('#ly-new-title').fill('Worked example');
    await page.locator('button[data-cmd="layer.add"]').click(); await idle(page);
    await nextId(page, 'example-text'); await click(page, 'Insert text');
    await edit(page.getByLabel('Text (%name% shows a variable)'), 'Example: Sam will confirm the room by noon.');
    await edit(page.getByLabel('Y', { exact: true }), 500);
    await edit(page.getByLabel('Width', { exact: true }), 800);
    await choose(page.locator('#edit-layer'), '');
    await tab(page, 'Triggers'); await click(page, '+ Add trigger');
    await choose(page.getByLabel('Event', { exact: true }), 'click');
    await choose(page.getByLabel('Event object'), 'review');
    await choose(page.getByLabel('Conditions', { exact: true }), 'all');
    await choose(page.getByLabel('Condition 1 variable', { exact: true }), 'reviewed');
    await choose(page.getByLabel('Condition 1 value', { exact: true }), 'false');
    await choose(page.getByLabel('Action 1 type'), 'setVar');
    await choose(page.getByLabel('Action 1 variable'), 'reviewed');
    await choose(page.getByLabel('Action 1 value'), 'true');
    await click(page, '+ Action'); await choose(page.getByLabel('Action 2 type'), 'setState');
    await choose(page.getByLabel('Action 2 object'), 'review'); await edit(page.getByLabel('Action 2 state'), 'selected');
    await click(page, '+ Action'); await choose(page.getByLabel('Action 3 type'), 'showLayer');
    await choose(page.getByLabel('Action 3 layer'), 'example'); await click(page, 'Add trigger');

    await page.locator('#slide-s-15').click();
    for (let i = 0; i < QUESTIONS.length; i++) {
      await nextId(page, `q-${i}`); await click(page, 'Add slide');
      await tab(page, 'Slide'); await edit(page.getByLabel('Slide title'), `Practice check ${i + 1}`);
      await tab(page, 'Question'); await click(page, 'Make this a question slide');
      await edit(page.getByLabel('Prompt'), QUESTIONS[i][0]);
      await edit(page.getByLabel('Choice 1 label'), QUESTIONS[i][1]);
      await edit(page.getByLabel('Choice 2 label'), QUESTIONS[i][2]);
      await page.locator('#q-choice-0-correct').check(); await idle(page);
      await click(page, 'Save question');
    }
    await tab(page, 'Course');
    await page.getByLabel('Quiz ID (optional)').fill('final'); await page.locator('#qz-new-title').fill('Handoff check');
    await click(page, 'Add quiz');
    await nextId(page, 'results');
    await page.getByRole('button', { name: /^Add a results slide for Handoff check/ }).click(); await idle(page);
    await tab(page, 'Course');
    await page.getByLabel('Use result: Handoff check').check(); await idle(page);
    await page.getByLabel('Slides viewed', { exact: true }).uncheck(); await idle(page);
    await choose(page.getByLabel('Report status as'), 'passed-failed');
    const doc = env.saved();
    expect(doc.slides).toHaveLength(18); expect(doc.assets).toHaveLength(1);
    expect(doc.slides[0].triggers[0]).toMatchObject({ if: { all: [{ var: 'reviewed', value: false }] }, do: [{ action: 'setVar' }, { action: 'setState' }, { action: 'showLayer' }] });
    expect(doc.quizzes[0]).toMatchObject({ questions: ['q-0', 'q-1'], results: 'results' });
    await reopenPreviewPublish(page, env, 'slides');
    await playPackages(page, env, 'slides', async (scope) => {
      await scope.getByRole('button', { name: 'Review example', exact: true }).click();
      await expect(scope.getByText('Example: Sam will confirm the room by noon.')).toBeVisible();
      await expect(scope.locator('[data-id="review"]')).toHaveAttribute('data-state', 'selected');
      for (let i = 0; i < TOPICS.length; i++) {
        await expect(scope.locator('.cf-slide-title')).toHaveText(TOPICS[i][0]);
        if (i === 9) await expect(scope.getByRole('img', { name: 'Owner leads to next action, then acknowledgement' })).toBeVisible();
        await scope.getByRole('button', { name: 'Next', exact: true }).click();
      }
      for (const [prompt, answer] of QUESTIONS) {
        await expect(scope.getByText(prompt, { exact: true })).toBeVisible();
        await scope.getByRole('radio', { name: answer, exact: true }).check();
        await scope.getByRole('button', { name: 'Submit', exact: true }).click();
        await expect(scope.getByRole('heading', { name: 'Correct', exact: true })).toBeVisible();
        await scope.getByRole('button', { name: 'Continue', exact: true }).click();
      }
      await expect(scope.locator('.cf-slide-title')).toContainText('Results');
      await expect(scope.getByText(/100%/)).toBeVisible();
    });
  } finally { await env.close(); }
});

async function insertBlock(page, type, id) {
  await nextId(page, id, true); await click(page, 'Insert block');
  await page.locator(`#lv-mi-${type}`).click(); await idle(page);
}
async function addLesson(page, id, title) {
  await nextId(page, id, true); await click(page, 'Add lesson');
  await edit(page.locator('#lf-title'), title);
}
async function questionBlock(page, id, question) {
  await insertBlock(page, 'question', id);
  for (const [label, text] of [['Prompt', question[0]], ['Choice 1 label', question[1]], ['Choice 2 label', question[2]]]) await edit(page.getByLabel(label, { exact: true }), text);
}

test('Q8 lessons: author five interactive lessons, reopen, preview, publish and finish web + SCORM through the UI', async ({ page, context }, info) => {
  test.setTimeout(180000);
  const env = await setup(page, context, info, 'lessons');
  try {
    await nextId(page, 'section', true); await click(page, 'Add section');
    await edit(page.getByLabel('Section title (section)'), 'Handoff workshop');
    const names = ['Prepare a useful handoff', 'Make the next step clear', 'Confirm shared understanding', 'Practise and reflect'];
    for (let i = 0; i < 4; i++) {
      await addLesson(page, `lesson-${i}`, names[i]);
      await insertBlock(page, 'text', `text-${i}`);
      await edit(page.getByLabel('Text (a blank line starts a new paragraph)'), TOPICS.slice(i * 4, i * 4 + 4).map(([title, body]) => `${title}\n${body}`).join('\n\n'));
      if (i === 0 || i === 1) {
        await insertBlock(page, i === 0 ? 'accordion' : 'tabs', `interactive-${i}`);
        const items = i === 0 ? [['Outcome', 'A recipient can continue the work.'], ['Owner', 'Name one person who accepts the next action.']]
          : [['Before sending', 'Separate confirmed facts from unknowns.'], ['After sending', 'Ask the owner to read back the next step.']];
        for (let j = 0; j < 2; j++) {
          if (j) await click(page, 'Add item');
          await edit(page.getByLabel(`Item ${j + 1} title`), items[j][0]);
          await edit(page.getByLabel(`Item ${j + 1} text`), items[j][1]);
        }
      } else if (i === 2) {
        await insertBlock(page, 'flashcards', 'cards');
        await edit(page.getByLabel('Card 1 front'), 'Message sent');
        await edit(page.getByLabel('Card 1 back'), 'Ask for acknowledgement; delivery is not acceptance.');
        await click(page, 'Add card');
        await edit(page.getByLabel('Card 2 front'), 'Owner unavailable');
        await edit(page.getByLabel('Card 2 back'), 'Use the agreed backup route and record acceptance.');
      } else await questionBlock(page, 'practice', QUESTIONS[0]);
      await insertBlock(page, 'continue', `gate-${i}`);
      await choose(page.getByLabel('Learners must complete'), 'above');
      await edit(page.getByLabel('Button label (optional; default Continue)'), 'Complete practice');
    }
    await addLesson(page, 'quiz', 'Final handoff check');
    await choose(page.getByLabel('Kind'), 'quiz');
    await edit(page.getByLabel('Pass mark (%)'), 80);
    await page.getByLabel('Lesson completes only when passed').check(); await idle(page);
    for (let i = 0; i < QUESTIONS.length; i++) await questionBlock(page, `final-${i}`, QUESTIONS[i]);
    await tab(page, 'Course');
    await edit(page.getByLabel('Description (shown on the cover)'), 'Allow 15–20 minutes. Read the guidance, complete each practice, and draft a real handoff before the final check.');
    await choose(page.getByLabel('Learners move through lessons'), 'restricted');
    await page.getByLabel('Quiz result').check(); await idle(page);
    await page.getByLabel('Lessons completed').uncheck(); await idle(page);
    await choose(page.getByLabel('Report status as'), 'passed-failed');
    expect(env.saved().sections[0].lessons).toHaveLength(5);
    expect(env.saved().sections[0].lessons.map((l) => l.blocks.map((b) => b.type))).toEqual([
      ['text', 'accordion', 'continue'], ['text', 'tabs', 'continue'], ['text', 'flashcards', 'continue'], ['text', 'question', 'continue'], ['question', 'question'],
    ]);
    await reopenPreviewPublish(page, env, 'lessons');
    await playPackages(page, env, 'lessons', async (scope) => {
      await scope.getByRole('button', { name: 'Start course' }).click();
      for (let i = 0; i < 4; i++) {
        await expect(scope.getByRole('heading', { name: names[i], exact: true })).toBeVisible();
        const gate = scope.getByRole('button', { name: 'Complete practice', exact: true });
        const next = scope.getByRole('button', { name: /Next lesson/ });
        await expect(next).toHaveAttribute('aria-disabled', 'true');
        await gate.click(); // locked gates explain the requirement and keep later content unavailable
        await expect(gate).toBeVisible();
        await expect(next).toHaveAttribute('aria-disabled', 'true');
        if (i === 0) { await scope.getByText('Outcome', { exact: true }).click(); await scope.getByText('Owner', { exact: true }).click(); }
        if (i === 1) await scope.getByRole('tab', { name: 'After sending' }).click();
        if (i === 2) { await scope.locator('.cfl-card').filter({ hasText: 'Message sent' }).click(); await scope.locator('.cfl-card').filter({ hasText: 'Owner unavailable' }).click(); }
        if (i === 3) { await scope.getByRole('radio', { name: QUESTIONS[0][1], exact: true }).check(); await scope.getByRole('button', { name: 'Submit', exact: true }).click(); }
        await expect(scope.locator('.cfl-gate-hint')).toHaveCount(0); await gate.click();
        await expect(gate).toHaveCount(0);
        await scope.locator('.cfl-end').scrollIntoViewIfNeeded();
        await scope.getByRole('button', { name: /Next lesson/ }).click();
      }
      await scope.getByRole('button', { name: 'Start quiz' }).click();
      for (let i = 0; i < QUESTIONS.length; i++) {
        await scope.getByRole('radio', { name: QUESTIONS[i][1], exact: true }).check();
        await scope.getByRole('button', { name: 'Submit', exact: true }).click();
        await scope.getByRole('button', { name: i === 0 ? 'Next question' : 'See results', exact: true }).click();
      }
      await expect(scope.getByRole('heading', { name: 'You passed' })).toBeVisible();
      await expect(scope.locator('.cfl-score-num')).toHaveText('100%');
      await expect(scope.getByRole('progressbar', { name: 'Course progress' })).toHaveAttribute('value', '100');
    });
  } finally { await env.close(); }
});
