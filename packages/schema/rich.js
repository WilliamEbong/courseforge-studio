// A formatted variable may span several runs; replacements inherit its first character's style.
export function replaceRichVariables(rich, replace) {
  return rich.map(paragraph => {
    const text = paragraph.runs.map(run => run.text).join('');
    const matches = [...text.matchAll(/%([A-Za-z_][A-Za-z0-9_.-]*)%/g)]
      .map(match => ({ start: match.index, end: match.index + match[0].length, text: replace(match[0], match[1]), original: match[0] }))
      .filter(match => match.text !== match.original);
    if (!matches.length) return { ...paragraph, runs: paragraph.runs.map(run => ({ ...run })) };
    const runs = [];
    let index = 0, offset = 0, position = 0;
    const consume = (end, keep) => {
      while (index < paragraph.runs.length && position < end) {
        const run = paragraph.runs[index];
        const length = Math.min(run.text.length - offset, end - position);
        if (keep && length) runs.push({ ...run, text: run.text.slice(offset, offset + length) });
        offset += length; position += length;
        if (offset === run.text.length) { index++; offset = 0; }
      }
    };
    for (const match of matches) {
      consume(match.start, true);
      while (!paragraph.runs[index].text.length) index++;
      runs.push({ ...paragraph.runs[index], text: match.text });
      consume(match.end, false);
    }
    consume(text.length, true);
    return { ...paragraph, runs };
  });
}
