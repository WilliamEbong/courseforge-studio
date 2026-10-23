// AI settings and daily usage, one small JSON file in the app's data folder.
// AI starts switched off; a request is refused before anything runs once today's limit is reached.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = { enabled: false, model: 'default', dailyRequests: 100 };
const today = () => new Date().toISOString().slice(0, 10);

export function createSettings(dataDir) {
  const file = path.join(dataDir, 'ai.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const write = (s) => { fs.mkdirSync(dataDir, { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, file); };
  const usageOf = (s) => ({ requests: 0, failures: 0, costUsd: 0, ...(s.usage?.[today()] ?? {}) });
  return {
    get() { const s = read(); return { ...DEFAULTS, ...s.settings, today: usageOf(s) }; },
    set(patch) {
      const s = read(), next = { ...DEFAULTS, ...s.settings };
      if ('enabled' in patch) next.enabled = patch.enabled === true;
      if ('model' in patch) { if (!['fast', 'default', 'best'].includes(patch.model)) throw Object.assign(new Error('model must be fast, default or best'), { status: 400 }); next.model = patch.model; }
      if ('dailyRequests' in patch) next.dailyRequests = Math.max(1, Math.min(1000, Math.round(Number(patch.dailyRequests)) || DEFAULTS.dailyRequests));
      write({ ...s, settings: next });
      return this.get();
    },
    /** Throw a plain-language error when AI is off or today's limit is used up. */
    check() {
      const g = this.get();
      if (!g.enabled) throw Object.assign(new Error('AI is switched off.'), { status: 409, errors: [{ path: '/ai', code: 'ai-off', message: 'AI is switched off.', hint: 'Turn it on in Settings → AI. Nothing is sent to Claude until you do.' }] });
      if (g.today.requests >= g.dailyRequests) throw Object.assign(new Error('daily limit'), { status: 429, errors: [{ path: '/ai', code: 'daily-limit', message: `You have used today's ${g.dailyRequests} AI requests.`, hint: 'The limit resets at midnight (UTC). You can raise it in Settings → AI.' }] });
    },
    record({ ok, costUsd = 0 }) {
      const s = read(), day = today(), u = usageOf(s);
      u.requests += 1; if (!ok) u.failures += 1; u.costUsd = Math.round((u.costUsd + costUsd) * 1e6) / 1e6;
      const usage = Object.fromEntries(Object.entries({ ...s.usage, [day]: u }).sort().slice(-31)); // keep a month
      write({ ...s, usage });
    },
  };
}
