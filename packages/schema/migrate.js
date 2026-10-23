// Schema migrations. A document names its version in `schema`; parse migrates older documents
// step by step to the current version before validating, and refuses newer ones with an actionable hint.
// Each step is {from, to, run(doc) -> doc}. cf.course/1 is the first version, so the table starts empty; add a step
// here (and a test) whenever a change is not additive.
export const CURRENT = 'cf.course/1';
export const MIGRATIONS = [];

const versionOf = (s) => { const m = /^cf\.course\/(\d+)$/.exec(String(s)); return m ? Number(m[1]) : null; };
const fail = (message, hint) => Object.assign(new Error(message), { errors: [{ path: '/schema', code: 'version', message, hint }] });

/** Migrate a parsed JSON document to CURRENT. Returns a new object when a step ran; throws {errors} when it cannot. */
export function migrate(raw, steps = MIGRATIONS, current = CURRENT) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw; // shape errors are validate()'s job
  const want = versionOf(current);
  let v = versionOf(raw.schema);
  if (v === null) throw fail(`unknown document version ${JSON.stringify(raw.schema)}`, `expected "${current}"; documents start with {"schema":"${current}", ...}`);
  if (v > want) throw fail(`this course was saved by a newer CourseForge Studio (${raw.schema}); this version reads up to ${current}`, 'update CourseForge Studio, or open the file with the version that created it');
  let doc = raw;
  while (v < want) {
    const step = steps.find((s) => s.from === `cf.course/${v}`);
    if (!step) throw fail(`no migration from cf.course/${v}`, `supported versions: ${[...new Set(steps.map((s) => s.from)), current].join(', ')}`);
    doc = { ...step.run(structuredClone(doc)), schema: step.to };
    v = versionOf(step.to);
  }
  return doc;
}
