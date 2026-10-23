// Create a course with AI: brief → outline (the author edits it) → build each scene or section on a hidden draft →
// the finished course appears under its name. Then an optional review lists findings the assistant can fix.
// Builds are resumable: progress is saved after every part, so a stop or crash continues where it left off.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyAll, describe, query } from '../core/index.js';
import { emptyCourse } from '../schema/index.js';
import { readZip } from '../import-story/zip-read.js';
import { inside } from '../server/projects.js';
import * as io from '../cli/io.js';
import * as claude from './claude.js';
import { ALLOWED, err, mcpConfigFor } from './assistant.js';
import { OUTLINE_SYSTEM, OUTLINE_SCHEMA, BUILD_SYSTEM, REVIEW_SYSTEM, REVIEW_SCHEMA } from './prompts.js';

const NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const DOCS = /\.(md|txt|docx|pdf)$/i;
/** Item limit from the target length: about three minutes per slide or lesson. */
export const maxItems = (minutes) => Math.max(3, Math.min(40, Math.round((Number(minutes) || 15) / 3)));

/** Text of an attached document (Markdown, text or Word); PDFs are read by Claude itself. Null when unreadable. */
export function documentText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md' || ext === '.txt') return fs.readFileSync(file, 'utf8');
  if (ext === '.docx') {
    const xml = readZip(fs.readFileSync(file)).read('word/document.xml').toString('utf8');
    return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
  }
  return null;
}

export function createFlow({ root, dataDir, settings, provider = claude }) {
  root = path.resolve(root);
  const work = (id) => { const d = path.join(dataDir, 'ai-runs', id); fs.mkdirSync(d, { recursive: true }); return d; };
  const model = (tier) => claude.MODELS[tier ?? settings.get().model] ?? claude.MODELS.default;
  const attachments = (list = []) => list.map((rel) => {
    const abs = typeof rel === 'string' && DOCS.test(rel) ? inside(root, rel) : null; // inside() refuses other drives, UNC paths and links
    if (!abs) throw err(400, 'path', `attachment not found or not a Word, PDF, Markdown or text file: ${rel}`, 'attach the file again');
    return abs;
  });
  const building = new Set(); // course names with a build running in this process
  async function call(opts) {
    settings.check();
    let r;
    try { r = await provider.run(opts); } finally { if (!opts.mcpConfig) fs.rmSync(opts.cwd, { recursive: true, force: true }); } // build runs keep their folder until the end
    settings.record({ ok: r.ok, costUsd: r.costUsd });
    if (!r.ok) throw err(502, r.error?.code ?? 'ai-error', r.error?.message ?? 'Claude did not finish.', r.error?.hint);
    return r;
  }
  const progressFile = (name) => path.join(dataDir, 'builds', `${name}.json`);

  /** Outline the course; checks the outline parses and fits the item limit (one retry with the reason). */
  async function outline({ brief = {}, attachments: att = [], signal }) {
    if (typeof brief.topic !== 'string' || brief.topic.trim().length < 3) throw err(400, 'required', 'Describe what the course is about.');
    const files = attachments(att);
    const docs = files.map((f) => ({ name: path.basename(f), text: documentText(f) }));
    const pdfs = files.filter((f, i) => docs[i].text === null); // Claude reads these itself, confined to their folder by --restricted
    const limit = maxItems(brief.minutes);
    const mode = brief.mode === 'lessons' ? 'lessons' : 'slides';
    const base = [`Course brief: ${brief.topic.trim()}`, brief.audience ? `Audience: ${brief.audience}` : '', `Length: about ${brief.minutes ?? 15} minutes, at most ${limit} items in total.`,
      `Format: ${mode === 'lessons' ? 'a scrolling lessons course (sections of lessons)' : 'a slide course (scenes of slides)'}.`,
      ...docs.filter((d) => d.text).map((d) => `\n<document name="${d.name}">\n${d.text.slice(0, 60000)}\n</document>`),
      pdfs.length ? `\nRead these attached PDF files with the Read tool: ${pdfs.join(', ')}` : ''].filter(Boolean).join('\n');
    let prompt = base, last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await call({ system: OUTLINE_SYSTEM, prompt, model: model(), jsonSchema: OUTLINE_SCHEMA, maxTurns: 6, cwd: work(`outline-${Date.now()}`), signal,
        ...(pdfs.length ? { tools: 'Read', allowedTools: ['Read'], addDirs: [...new Set(pdfs.map((p) => path.dirname(p)))] } : {}) });
      const out = r.structured ?? (() => { try { return JSON.parse(r.text); } catch { return null; } })();
      if (!out?.outline) { last = 'the reply had no outline'; prompt = `${base}\n\nYour previous reply had no outline. Return the JSON with "title" and "outline".`; continue; }
      const check = applyAll(emptyCourse({ mode }), [{ cmd: 'outline.add', args: { text: out.outline } }]);
      const items = out.outline.split('\n').filter((l) => /^##\s/.test(l.trim())).length; // items, not slides: a question item adds a question slide
      if (check.ok && items <= limit) return { title: (out.title || brief.topic).trim().slice(0, 120), outline: out.outline.trim(), items, limit };
      last = check.ok ? `${items} items, more than the limit of ${limit}` : check.errors[0].message;
      prompt = `${base}\n\nYour previous outline was not usable (${last}). Write it again, following the format and the limit exactly.\n\nPrevious outline:\n${out.outline}`;
    }
    throw err(502, 'outline', `Claude's outline could not be used: ${last}.`, 'Try again, or shorten the brief.');
  }

  /** Build the course: create the draft from the outline, then one Claude session per scene or section. */
  async function build({ name, title, mode = 'slides', outline: text, brief = {}, signal, onEvent = () => {} }) {
    if (!NAME.test(name ?? '')) throw err(400, 'pattern', 'The file name must use lowercase letters, digits and dashes, for example "fire-safety".');
    const taken = () => ['.course.json', '.story'].some((ext) => fs.existsSync(path.join(root, name + ext)));
    if (taken()) throw err(409, 'dupe', `A course named "${name}" already exists.`, 'Choose another file name.');
    if (building.has(name)) throw err(409, 'busy', `"${name}" is already being built.`, 'Wait for it to finish, or choose another file name.');
    building.add(name);
    try {
      const final = path.join(root, `${name}.course.json`), draft = path.join(root, `.ai-draft-new-${name}.course.json`);
      mode = mode === 'lessons' ? 'lessons' : 'slides';
      const key = crypto.createHash('sha256').update(JSON.stringify([title, mode, text])).digest('hex'); // an edited outline starts over
      let progress = null;
      try { progress = JSON.parse(fs.readFileSync(progressFile(name), 'utf8')); } catch { /* a new build */ }
      if (progress?.key !== key || !fs.existsSync(draft)) {
        const start = applyAll(emptyCourse({ title, mode }), [{ cmd: 'outline.add', args: { text } }]);
        if (!start.ok) throw err(400, 'outline', `The outline has a problem: ${start.errors[0].message}`, start.errors[0].hint);
        const doc = start.doc;
        if (mode !== 'lessons') doc.scenes = doc.scenes.filter((s) => s.slides.length); // drop the empty starting scene
        fs.rmSync(`${draft}.history.json`, { force: true });
        io.saveCourse(draft, doc);
        progress = { name, key, done: [] };
        fs.mkdirSync(path.dirname(progressFile(name)), { recursive: true });
        fs.writeFileSync(progressFile(name), JSON.stringify(progress));
      }
      const doc = io.loadCourse(draft);
      const parts = mode === 'lessons' ? doc.sections.map((s) => ({ id: s.id, label: `section ${s.id} "${s.title}" (its lessons: add blocks with the lesson and block commands)` }))
        : doc.scenes.map((s) => ({ id: s.id, label: `scene ${s.id} "${s.title}" (its slides: ${s.slides.join(', ')})` }));
      const rel = path.relative(root, draft).split(path.sep).join('/');
      const dir = work(`build-${name}`);
      const mcpConfig = mcpConfigFor(root, rel, dir);
      let costUsd = 0;
      for (const [i, part] of parts.entries()) {
        if (progress.done.includes(part.id)) continue;
        onEvent({ type: 'part', index: i, total: parts.length, title: part.label.match(/"(.*)"/)?.[1] ?? part.id });
        const r = await call({ system: BUILD_SYSTEM(rel, part.label), prompt: `Course brief: ${brief.topic ?? title}${brief.audience ? `\nAudience: ${brief.audience}` : ''}\n\nBuild ${part.label} now.`,
          model: model(), mcpConfig, allowedTools: ALLOWED, maxTurns: 14, cwd: dir, draftFile: draft, signal, onEvent });
        costUsd += r.costUsd;
        progress.done.push(part.id);
        fs.writeFileSync(progressFile(name), JSON.stringify(progress));
      }
      const built = io.loadCourse(draft);
      const issues = [...query(built, 'validate').data, ...query(built, 'a11y').data];
      // The course appears only when complete, and never over one created meanwhile: COPYFILE_EXCL fails if the name is taken.
      if (taken()) throw err(409, 'dupe', `A course named "${name}" was created while this one was being built.`, 'Choose another file name and build again; the finished parts are kept.');
      fs.copyFileSync(draft, final, fs.constants.COPYFILE_EXCL);
      for (const f of [draft, `${draft}.history.json`, progressFile(name)]) fs.rmSync(f, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
      return { name, file: path.basename(final), parts: parts.length, issues: issues.length, costUsd };
    } finally { building.delete(name); }
  }

  /** Review a course with the fast model: up to 10 findings, each with a fix the assistant can apply. */
  async function review({ file, signal }) {
    const doc = io.loadCourse(file);
    const a11y = query(doc, 'a11y').data;
    const r = await call({ system: REVIEW_SYSTEM, prompt: `Course outline:\n${describe(doc, { full: true })}\n\nAutomatic accessibility check:\n${JSON.stringify(a11y).slice(0, 20000)}`,
      model: model('fast'), jsonSchema: REVIEW_SCHEMA, maxTurns: 3, cwd: work(`review-${Date.now()}`), signal });
    const out = r.structured ?? (() => { try { return JSON.parse(r.text); } catch { return null; } })();
    return { findings: (out?.findings ?? []).slice(0, 10), costUsd: r.costUsd };
  }

  return { outline, build, review, inProgress: (name) => fs.existsSync(progressFile(name)) };
}
