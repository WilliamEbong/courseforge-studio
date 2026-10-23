// Classic-script build of the runtime for published packages. No bundler: the schema import
// line is replaced with inline shims, the lessons import with lessons.js itself, and the module keywords are stripped,
// so the browser runs the same source the tests run.
import { readFileSync } from 'node:fs';
import { INTERACTIVE, COMPLETABLE, isCompletable, scenarioStep } from '../schema/index.js';

const IMPORT_LINE = "import { normalize, INTERACTIVE } from '../schema/index.js';";
const LESSONS_LINE = "import { createLessonRuntime } from './lessons.js';";
const RICH_LINE = "import { replaceRichVariables } from '../schema/rich.js';";

export function playerBundle() {
  const shared = ['rich.js', 'line.js'].map((f) => readFileSync(new URL(`../player/${f}`, import.meta.url), 'utf8').replace(/^export /gm, '')).join('\n');
  const player = readFileSync(new URL('../player/cf-player.js', import.meta.url), 'utf8');
  return player.replace("  'use strict';", () => "  'use strict';\n" + shared);
}

export function runtimeBundle() {
  const read = (f) => readFileSync(new URL(`../runtime/${f}`, import.meta.url), 'utf8');
  const src = read('index.js');
  for (const line of [IMPORT_LINE, LESSONS_LINE, RICH_LINE]) if (!src.includes(line)) throw new Error(`runtimeBundle: packages/runtime/index.js no longer has ${line}; update bundle.js`);
  const shims = 'const normalize = (d) => d; // documents are normalized at publish time\n'
    + `const INTERACTIVE = new Set(${JSON.stringify([...INTERACTIVE])});\n`
    + `const COMPLETABLE = new Set(${JSON.stringify([...COMPLETABLE])});\nconst isCompletable = ${isCompletable};\nconst scenarioStep = ${scenarioStep};`;
  const lessons = read('lessons.js').replace(/^import .*;$/gm, ''); // its imports resolve to the shims and index.js in the same scope
  const rich = readFileSync(new URL('../schema/rich.js', import.meta.url), 'utf8');
  const body = src.replace(IMPORT_LINE, shims).replace(LESSONS_LINE, () => lessons).replace(RICH_LINE, () => rich).replace(/^export /gm, '');
  return `// CourseForge Studio runtime (generated from packages/runtime/index.js and lessons.js by packages/publisher/bundle.js)\n(function () {\n'use strict';\n${body}\nwindow.CFRuntime = { createRuntime, play, seededRng };\n})();\n`;
}
