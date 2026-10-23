// Original OOXML package helpers; ZIP bytes come from the existing publisher.
import fs from 'node:fs';
import path from 'node:path';
import { zipDir } from './zip.js';
import { validate, normalize } from '../schema/index.js';

export const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
export const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export function xml(value) {
  const s = String(value ?? '');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(s) || !s.isWellFormed()) throw new Error('export: text contains invalid XML characters');
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}
export const relationships = (rels) => XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map(r => `<Relationship Id="${xml(r.id)}" Type="${REL}/${r.type}" Target="${xml(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
export const contentTypes = (parts, defaults = {}) => XML + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(defaults).map(([ext, type]) => `<Default Extension="${xml(ext)}" ContentType="${xml(type)}"/>`).join('')}${Object.entries(parts).map(([name, type]) => `<Override PartName="/${xml(name)}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join('')}</Types>`;

export function validCourse(doc) {
  const errors = validate(doc);
  if (errors.length) throw Object.assign(new Error(`export: invalid course: ${errors[0].path} ${errors[0].message}`), { errors });
  return normalize(doc);
}
export const addIssue = (report) => (path, kind, reason) => report.push({ path, kind, reason });
export function omitted(obj, allowed, at, add, reason = 'Not represented in this export; use the web folder to retain runtime behavior.') {
  for (const [k, v] of Object.entries(obj)) {
    if (allowed.includes(k) || v == null || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Object.keys(v).length)) continue;
    add(`${at}/${k}`, k, reason);
  }
}

export function packageBytes(files, parent) {
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, '.cf-ooxml-'));
  try {
    for (const [name, data] of Object.entries(files)) {
      const dest = path.join(dir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data);
    }
    return zipDir(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export function outputPath(out, extensions) {
  const output = path.resolve(out), report = output + '.export-report.json';
  if (!extensions.includes(path.extname(output).toLowerCase())) throw new Error(`export: output must end in ${extensions.join(' or ')}`);
  for (const f of [output, report]) if (fs.existsSync(f) || fs.lstatSync(f, { throwIfNoEntry: false })) throw new Error(`export: file exists: ${f}; choose a new filename`);
  return output;
}

export function writeExport(output, data, issues, counts) {
  const report = output + '.export-report.json';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // Exclusive creation protects source files and handles another publisher winning the race.
  fs.writeFileSync(output, data, { flag: 'wx' });
  try { fs.writeFileSync(report, JSON.stringify(issues, null, 2) + '\n', { flag: 'wx' }); }
  catch (e) { fs.unlinkSync(output); throw e; }
  return { output, report, files: [path.basename(output), path.basename(report)], ...counts, issues: issues.length };
}
