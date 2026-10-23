import path from 'node:path';
import { XML, REL, S, xml, relationships, contentTypes, validCourse, addIssue, omitted, packageBytes, outputPath, writeExport } from './ooxml.js';

// No documented literal escape exists in the import grammar. Visible substitutions are reported.
function learnerText(value, at, add) {
  const before = String(value ?? '');
  const after = before.replace(/\|/g, '｜').replace(/\*/g, '＊').replace(/\/\//g, '／／').replace(/[\r\n\t]+/g, ' ').trim();
  if (after !== before) add(at, 'text', 'Import delimiters |, *, // became fullwidth characters; line breaks/tabs became spaces and edge whitespace was trimmed. Check wording and accepted answers after import.');
  return after;
}

function questionRow(q, at, add) {
  const codes = { tf: 'TF', mc: 'MC', mr: 'MR', fill: 'FIB', matching: 'MDN', sequence: 'SD' };
  const type = q.type ?? q.kind, code = codes[type];
  if (!code) { add(at, 'question', `Unsupported question type ${type}; recreate it in Storyline or embed the web folder.`); return null; }
  const points = q.points ?? 10;
  if (!Number.isInteger(points) || points < -1000 || points > 1000) { add(at + '/points', 'question', 'Question skipped: import points must be an integer from -1000 to 1000.'); return null; }
  const clean = (s, p) => learnerText(s, at + p, add);
  const prompt = clean(q.prompt, '/prompt');
  if (!prompt) { add(at, 'question', 'Question skipped: question text is required.'); return null; }
  let answers;
  if (type === 'fill') answers = q.answers.map((v, i) => clean(v, `/answers/${i}`));
  else if (type === 'matching') {
    const pairs = q.pairs ?? q.rows.map(r => ({ left: r.label, right: q.choices.find(c => c.id === r.choice).label }));
    const targets = pairs.map(r => r.right);
    if (new Set(targets).size !== targets.length || (q.choices && q.choices.length !== pairs.length)) {
      add(at, 'question', 'Question skipped: shared matching targets or unused choices cannot preserve the one-pair-per-choice import layout.'); return null;
    }
    answers = pairs.map((r, i) => {
      const left = clean(r.left, `/pairs/${i}/left`), right = clean(r.right, `/pairs/${i}/right`);
      return left && right ? `${left}|${right}` : '';
    });
  } else if (type === 'sequence') answers = q.choices.map((c, i) => clean(c.label, `/choices/${i}/label`));
  else {
    let choices = q.choices;
    if (type === 'tf') {
      if (!choices.every(c => /^(true|false)$/i.test(c.label.trim())) || new Set(choices.map(c => c.label.trim().toLowerCase())).size !== 2) {
        add(at, 'question', 'Question skipped: TF import requires True and False labels; custom two-choice wording cannot be preserved.'); return null;
      }
      choices = choices.map(c => ({ ...c, label: /^true$/i.test(c.label.trim()) ? 'True' : 'False' }));
    }
    answers = choices.map((c, i) => {
      const feedback = c.feedback ?? (c.correct ? q.feedback?.correct : q.feedback?.incorrect) ?? q.feedback?.any;
      const label = clean(c.label, `/choices/${i}/label`);
      return label ? `${c.correct ? '*' : ''}${label}${feedback ? '|' + clean(feedback, `/choices/${i}/feedback`) : ''}` : '';
    });
  }
  if (!answers.length || answers.length > 10 || answers.some(s => !s)) { add(at, 'question', 'Question skipped: imports require 1 to 10 non-empty answers; no answers were truncated.'); return null; }
  omitted(q, ['type', 'kind', 'prompt', 'points', 'choices', 'answers', 'rows', 'pairs', 'id', ...(type === 'tf' || type === 'mc' || type === 'mr' ? ['feedback'] : [])], at, add);
  if (q.feedback?.tryAgain) add(at + '/feedback/tryAgain', 'feedback', 'Try-again feedback has no per-choice import field.');
  return [code, points, prompt, ...answers];
}

// shortcut: assumed block layout from the task; adjust only here if the lead's Storyline import rejects TXT.
export const questionText = (rows) => rows.map(row => row.join('\r\n')).join('\r\n\r\n') + (rows.length ? '\r\n' : '');

function workbook(rows) {
  const sheet = XML + `<worksheet xmlns="${S}"><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((cell, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}"${j === 1 ? '' : ' t="inlineStr"'}>${j === 1 ? `<v>${cell}</v>` : `<is><t xml:space="preserve">${xml(cell)}</t></is>`}</c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  return {
    '[Content_Types].xml': contentTypes({ 'xl/workbook.xml': 'spreadsheetml.sheet.main', 'xl/worksheets/sheet1.xml': 'spreadsheetml.worksheet' }),
    '_rels/.rels': relationships([{ id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' }]),
    'xl/workbook.xml': XML + `<workbook xmlns="${S}" xmlns:r="${REL}"><sheets><sheet name="Questions" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationships([{ id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' }]),
    'xl/worksheets/sheet1.xml': sheet,
  };
}

export function publishQuestions(doc, out) {
  const output = outputPath(out, ['.xlsx', '.txt']), d = validCourse(doc), issues = [], add = addIssue(issues), rows = [];
  omitted(d, ['schema', 'id', 'slides', 'sections'], '', add, 'Question files contain question data only; course visuals, assets, structure and runtime settings are not exported.');
  d.slides.forEach((s, i) => {
    omitted(s, ['id', 'question'], `/slides/${i}`, add);
    if (s.question) { const row = questionRow(s.question, `/slides/${i}/question`, add); if (row) rows.push(row); }
  });
  d.sections.forEach((s, i) => {
    omitted(s, ['id', 'lessons'], `/sections/${i}`, add);
    s.lessons.forEach((l, j) => {
      const at = `/sections/${i}/lessons/${j}`;
      omitted(l, ['id', 'blocks'], at, add);
      l.blocks.forEach((b, k) => {
        if (b.type !== 'question') { add(`${at}/blocks/${k}`, 'block', 'Non-question lesson block is not exported.'); return; }
        const row = questionRow({ ...b, type: b.kind }, `${at}/blocks/${k}`, add); if (row) rows.push(row);
        add(`${at}/blocks/${k}`, 'points', 'Lesson questions export with 10 points; lesson quiz weighting/settings must be configured in Storyline.');
      });
    });
  });
  if (output.toLowerCase().endsWith('.txt')) add('/', 'format', 'TXT block layout is assumed; confirm by importing into Storyline. XLSX is the preferred format.');
  const data = output.toLowerCase().endsWith('.txt') ? questionText(rows) : packageBytes(workbook(rows), path.dirname(output));
  return writeExport(output, data, issues, { questions: rows.length });
}
