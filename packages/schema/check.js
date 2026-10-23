// Schema-lite: a tiny JSON-Schema subset shared by document validation, command args and agent docs.
// Keywords: type, enum, const, pattern, minimum, maximum, maxLength, minItems, maxItems, properties, required,
// additionalProperties:false, items, default, description, and `union: {key, map}` for tagged unions.

const isType = (t, v) =>
  t === 'any' ? v !== undefined
    : t === 'array' ? Array.isArray(v)
      : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
        : t === 'integer' ? Number.isInteger(v)
          : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
            : t === 'null' ? v === null
              : typeof v === t;

const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

/** Validate `value` against `schema`; returns [{path, code, message, hint?}] (JSON-pointer paths). */
export function check(schema, value, path = '') {
  const errs = [];
  walk(schema, value, path, errs);
  return errs;
}

function walk(s, v, path, errs) {
  if (!s || v === undefined) return;
  const p = path || '/';
  if (s.type) {
    const types = [].concat(s.type);
    if (!types.some((t) => isType(t, v))) { errs.push({ path: p, code: 'type', message: `expected ${types.join(' or ')}, got ${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}` }); return; }
  }
  if ('const' in s && v !== s.const) errs.push({ path: p, code: 'enum', message: `must be ${JSON.stringify(s.const)}` });
  if (s.enum && !s.enum.includes(v)) errs.push({ path: p, code: 'enum', message: `must be one of: ${s.enum.join(', ')}`, hint: `got ${JSON.stringify(v)}` });
  if (typeof v === 'string') {
    if (s.pattern && !new RegExp(s.pattern).test(v)) errs.push({ path: p, code: 'pattern', message: `must match ${s.pattern}`, hint: `got ${JSON.stringify(v)}` });
    if (s.maxLength !== undefined && v.length > s.maxLength) errs.push({ path: p, code: 'range', message: `longer than ${s.maxLength} characters` });
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) errs.push({ path: p, code: 'range', message: `must be >= ${s.minimum}` });
    if (s.maximum !== undefined && v > s.maximum) errs.push({ path: p, code: 'range', message: `must be <= ${s.maximum}` });
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errs.push({ path: p, code: 'range', message: `needs at least ${s.minItems} item(s)` });
    if (s.maxItems !== undefined && v.length > s.maxItems) errs.push({ path: p, code: 'range', message: `allows at most ${s.maxItems} item(s)` });
    // An array hole or undefined element is never valid (in-memory documents from agents can contain one).
    if (s.items) {
      for (let i = 0; i < v.length; i++) { // index loop: forEach would skip holes
        if (v[i] === undefined) errs.push({ path: `${path}/${i}`, code: 'type', message: 'expected a value, got undefined' });
        else walk(s.items, v[i], `${path}/${i}`, errs);
      }
    }
  }
  if (isType('object', v)) {
    let props = s.properties;
    if (s.union) {
      const tag = v[s.union.key];
      const branch = Object.hasOwn(s.union.map, tag) ? s.union.map[tag] : undefined;
      if (!branch) { errs.push({ path: `${path}/${s.union.key}`, code: tag === undefined ? 'required' : 'enum', message: `${s.union.key} must be one of: ${Object.keys(s.union.map).join(', ')}`, hint: tag === undefined ? undefined : `got ${JSON.stringify(tag)}` }); return; }
      props = { [s.union.key]: { type: 'string' }, ...(s.properties || {}), ...(branch.properties || {}) };
      for (const r of branch.required || []) if (v[r] === undefined) errs.push({ path: `${path}/${esc(r)}`, code: 'required', message: `${r} is required for ${s.union.key}=${tag}` });
    }
    if (props) {
      for (const r of s.required || []) if (v[r] === undefined) errs.push({ path: `${path}/${esc(r)}`, code: 'required', message: `${r} is required` });
      for (const [k, sub] of Object.entries(props)) walk(sub, v[k], `${path}/${esc(k)}`, errs);
      if (s.additionalProperties === false) {
        for (const k of Object.keys(v)) if (!Object.hasOwn(props, k)) errs.push({ path: `${path}/${esc(k)}`, code: 'unknown', message: `unknown property "${k}"`, hint: `allowed: ${Object.keys(props).join(', ')}` });
      }
    }
    if (s.values) for (const [k, x] of Object.entries(v)) walk(s.values, x, `${path}/${esc(k)}`, errs);
  }
}

/** Fill defaults (deep-cloned) for missing properties, recursively. Mutates and returns v. */
export function applyDefaults(s, v) {
  if (!s || v === undefined || v === null) return v;
  if (Array.isArray(v) && s.items) { v.forEach((x) => applyDefaults(s.items, x)); return v; }
  if (isType('object', v)) {
    const props = s.union ? { ...(s.properties || {}), ...((s.union.map[v[s.union.key]] || {}).properties || {}) } : s.properties;
    for (const [k, sub] of Object.entries(props || {})) {
      if (v[k] === undefined && 'default' in sub) v[k] = structuredClone(sub.default);
      applyDefaults(sub, v[k]);
    }
    if (s.values) for (const x of Object.values(v)) applyDefaults(s.values, x);
  }
  return v;
}

// JSON with sorted keys, for order-insensitive equality.
const stable = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));

/** Return a copy with canonical key order (schema order, then sorted extras) and default-valued keys omitted. */
export function canonical(s, v) {
  if (Array.isArray(v)) return v.map((x) => canonical(s && s.items, x));
  if (!isType('object', v)) return v;
  const props = !s ? {} : s.union
    ? { [s.union.key]: {}, ...(s.properties || {}), ...((s.union.map[v[s.union.key]] || {}).properties || {}) }
    : (s.properties || {});
  const out = {};
  const keys = [...Object.keys(props).filter((k) => Object.hasOwn(v, k)), ...Object.keys(v).filter((k) => !Object.hasOwn(props, k)).sort()];
  for (const k of keys) {
    const sub = (Object.hasOwn(props, k) && props[k]) || (s && s.values);
    if (v[k] === undefined) continue;
    if (sub && 'default' in sub && stable(sub.default) === stable(v[k]) && !(s.required || []).includes(k)) continue;
    out[k] = canonical(sub, v[k]);
  }
  return out;
}

/** Convert schema-lite to standard JSON Schema (draft 2020-12 subset) for agents and MCP tool definitions. */
export function toJsonSchema(s) {
  if (!s || typeof s !== 'object') return {};
  const out = {};
  for (const k of ['type', 'enum', 'const', 'pattern', 'minimum', 'maximum', 'maxLength', 'minItems', 'maxItems', 'required', 'additionalProperties', 'default', 'description']) {
    if (k in s) out[k] = k === 'type' && s.type === 'any' ? undefined : s[k];
  }
  if (out.type === undefined) delete out.type;
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.values) out.additionalProperties = toJsonSchema(s.values);
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, x]) => [k, toJsonSchema(x)]));
  if (s.union) {
    out.oneOf = Object.entries(s.union.map).map(([tag, b]) => ({
      type: 'object',
      properties: { [s.union.key]: { const: tag }, ...Object.fromEntries(Object.entries(b.properties || {}).map(([k, x]) => [k, toJsonSchema(x)])) },
      required: [s.union.key, ...(b.required || [])],
      ...(b.description ? { description: b.description } : {}),
    }));
  }
  return out;
}
