import fs from 'node:fs';
import path from 'node:path';
import { XML, P, A, REL, xml, relationships, contentTypes, validCourse, addIssue, omitted, packageBytes, outputPath, writeExport } from './ooxml.js';

const NS = `xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${REL}"`;
const emu = n => Math.round(n * 9525);
const point = n => Math.round(n * 75); // CSS px -> hundredths of a point.
const MAP = '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>';
const OVERRIDE = '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>';
const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const tree = body => `<p:spTree>${GROUP}${body}</p:spTree>`;

function color(value, fallback, at, add) {
  if (value == null) return fallback;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.slice(1).toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) return [...value.slice(1)].map(c => c + c).join('').toUpperCase();
  add(at, 'color', `Unsupported color ${value}; using ${fallback ? '#' + fallback : 'no fill'}.`); return fallback;
}
const solid = (c, opacity = 1) => c ? `<a:solidFill><a:srgbClr val="${c}">${opacity !== 1 ? `<a:alpha val="${Math.round(opacity * 100000)}"/>` : ''}</a:srgbClr></a:solidFill>` : '<a:noFill/>';
function xfrm(o) {
  return `<a:xfrm rot="${Math.round((o.rotation ?? 0) * 60000)}"><a:off x="${emu(o.x ?? 0)}" y="${emu(o.y ?? 0)}"/><a:ext cx="${emu(o.w ?? 200)}" cy="${emu(o.h ?? 60)}"/></a:xfrm>`;
}
function textBody(o, at, add, rels) {
  const st = o.style ?? {}, paras = o.rich ?? String(o.text ?? '').split(/\r?\n/).map(text => ({ runs: [{ text }] }));
  const align = { left: 'l', center: 'ctr', right: 'r', justify: 'just' };
  const paragraphs = paras.map((p, i) => {
    const runs = p.runs.map((r, j) => {
      const rp = `${at}/rich/${i}/runs/${j}`, size = r.size ?? st.fontSize ?? 20;
      const face = r.font ?? st.fontFamily ?? 'Arial';
      const font = face.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      if (font !== face) add(rp + '/font', 'font', 'CSS font stack reduced to its first font; installed-font substitution may differ in PowerPoint.');
      const attrs = `lang="en-US" sz="${point(size)}" b="${(r.b ?? st.bold) ? 1 : 0}" i="${(r.i ?? st.italic) ? 1 : 0}" u="${(r.u ?? st.underline) ? 'sng' : 'none'}" strike="${r.s ? 'sngStrike' : 'noStrike'}"`;
      let link = '';
      if (r.link) {
        if (/^(https?:\/\/|mailto:)/i.test(r.link)) { const id = `rId${rels.length + 1}`; rels.push({ id, type: 'hyperlink', target: r.link, external: true }); link = `<a:hlinkClick r:id="${id}"/>`; }
        else add(rp + '/link', 'link', 'Link omitted: only http, https and mailto links are exported.');
      }
      const props = `<a:rPr ${attrs}>${solid(color(r.color ?? st.color, o.type === 'button' ? 'FFFFFF' : '202020', rp + '/color', add), st.opacity)}<a:latin typeface="${xml(font)}"/>${link}</a:rPr>`;
      return r.text.split(/\r?\n/).map(t => `<a:r>${props}<a:t>${xml(t)}</a:t></a:r>`).join('<a:br/>');
    }).join('');
    const level = (p.level ?? 1) - 1; // course levels start at 1, PowerPoint lvl at 0
    const list = p.list === 'bullet' ? '<a:buChar char="•"/>' : p.list === 'number' ? '<a:buAutoNum type="arabicPeriod"/>' : '<a:buNone/>';
    return `<a:p><a:pPr lvl="${level}" algn="${align[p.align ?? st.align] ?? 'l'}"${p.list ? ` marL="${emu(24 * (level + 1))}" indent="-${emu(18)}"` : ''}>${list}</a:pPr>${runs}<a:endParaRPr lang="en-US"/></a:p>`;
  }).join('');
  const pad = emu(st.padding ?? 0), anchor = { top: 't', middle: 'ctr', bottom: 'b' }[st.valign] ?? 't';
  return `<p:txBody><a:bodyPr wrap="square" lIns="${pad}" tIns="${pad}" rIns="${pad}" bIns="${pad}" anchor="${anchor}"/><a:lstStyle/>${paragraphs || '<a:p/>'}</p:txBody>`;
}
function shape(o, id, at, add, rels, placeholder) {
  const st = o.style ?? {};
  const presets = { rect: 'rect', rounded: 'roundRect', ellipse: 'ellipse', line: 'line', arrow: 'line' }; // an arrow is a line with a head
  const preset = o.type === 'button' ? 'roundRect' : Object.hasOwn(presets, o.shape) ? presets[o.shape] : 'rect';
  if (o.type === 'shape' && !Object.hasOwn(presets, o.shape)) add(at + '/shape', 'shape', `Shape ${o.shape} approximated as a rectangle.`);
  const fill = color(st.fill, o.type === 'text' ? null : o.type === 'button' ? '0B6E6E' : 'E5E7EB', at + '/style/fill', add);
  const border = color(st.border, preset === 'line' ? '202020' : null, at + '/style/border', add);
  omitted(st, ['fill', 'border', 'borderWidth', 'color', 'fontSize', 'fontFamily', 'bold', 'italic', 'underline', 'align', 'valign', 'opacity', 'padding'], at + '/style', add, 'Visual style is not represented exactly in PowerPoint.');
  const geometry = preset === 'line' ? { ...o, y: (o.y ?? 0) + (o.h ?? 60) / 2, h: 0 } : o;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(o.name ?? o.id)}" descr="${xml(o.alt)}"/><p:cNvSpPr${o.type === 'text' ? ' txBox="1"' : ''}/><p:nvPr>${placeholder ? `<p:ph type="${placeholder}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr>${xfrm(geometry)}<a:prstGeom prst="${preset}"><a:avLst/></a:prstGeom>${preset === 'line' ? '<a:noFill/>' : solid(fill, st.opacity)}<a:ln w="${emu(Math.max(0, st.borderWidth ?? 1))}">${solid(border, st.opacity)}${o.shape === 'arrow' ? '<a:tailEnd type="triangle"/>' : ''}</a:ln></p:spPr>${textBody(o, at, add, rels)}</p:sp>`;
}

function theme() {
  const colors = { dk1: '202020', lt1: 'FFFFFF', dk2: '404040', lt2: 'EEEEEE', accent1: '0B6E6E', accent2: 'B24D2B', accent3: '42613B', accent4: '615080', accent5: '216A8C', accent6: '94752C', hlink: '0563C1', folHlink: '954F72' };
  return XML + `<a:theme xmlns:a="${A}" name="CourseForge Studio"><a:themeElements><a:clrScheme name="CourseForge Studio">${Object.entries(colors).map(([k, v]) => `<a:${k}><a:srgbClr val="${v}"/></a:${k}>`).join('')}</a:clrScheme><a:fontScheme name="CourseForge Studio">${['majorFont', 'minorFont'].map(k => `<a:${k}><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:${k}>`).join('')}</a:fontScheme><a:fmtScheme name="CourseForge Studio"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[9525, 19050, 28575].map(w => `<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

export function publishPptx(doc, out, { courseDir, planAssets } = {}) {
  const output = outputPath(out, ['.pptx']), d = validCourse(doc), issues = [], add = addIssue(issues);
  const assets = planAssets(d, courseDir), used = new Set(), media = new Map();
  const files = {}, types = {}, imageTypes = {};
  const part = (name, type, body) => { files[name] = XML + body; types[name] = 'presentationml.' + type; };
  omitted(d, ['schema', 'id', 'title', 'size', 'slides', 'assets'], '', add);
  add('/title', 'title', 'Slide titles are added as title placeholders at the top; check overlap with existing slide objects after import.');
  const presRels = [{ id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }, { id: 'rId2', type: 'presProps', target: 'presProps.xml' }];
  const hasNotes = d.slides.some(s => s.notes);
  if (hasNotes) presRels.push({ id: 'rId3', type: 'notesMaster', target: 'notesMasters/notesMaster1.xml' });
  const slideIds = [];
  // Slides in the order learners meet them (scenes), not file order; bank-only slides travel in the question file (007 #8).
  const flow = d.scenes.flatMap((sc) => sc.slides).map((sid) => d.slides.find((x) => x.id === sid)).filter(Boolean);
  d.slides.forEach((s, i) => { if (!flow.includes(s)) add(`/slides/${i}`, 'slide', 'A question-bank slide is not a deck slide; export the question file for it.'); });
  flow.forEach((s, k) => {
    const i = d.slides.indexOf(s), n = k + 1, at = `/slides/${i}`, rels = [{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }];
    const id = `rId${presRels.length + 1}`; presRels.push({ id, type: 'slide', target: `slides/slide${n}.xml` });
    slideIds.push(`<p:sldId id="${256 + k}" r:id="${id}"/>`);
    omitted(s, ['id', 'title', 'background', 'objects', 'notes'], at, add);
    let body = shape({ id: 'Title', type: 'text', text: s.title, x: 24, y: 12, w: Math.max(1, d.size.w - 48), h: 48, style: { fontSize: 28 } }, 2, at + '/title', add, rels, 'title');
    s.objects.forEach((o, j) => {
      const op = `${at}/objects/${j}`;
      if (o.hidden || o.initialState === 'hidden' || o.states?.[o.initialState]?.hidden) { add(op, 'hidden', 'Hidden-at-start object skipped.'); return; }
      if (!['text', 'shape', 'button', 'image'].includes(o.type)) { add(op, 'object', `Unsupported ${o.type} object; embed web output to retain it.`); return; }
      omitted(o, ['id', 'type', 'name', 'x', 'y', 'w', 'h', 'rotation', 'text', 'rich', 'style', 'image', 'alt', 'shape', 'hidden'], op, add);
      if (o.type !== 'image') { body += shape(o, j + 3, op, add, rels); return; }
      const asset = assets.find(a => a.asset.id === o.image);
      const ext = path.extname(asset.src).slice(1).toLowerCase();
      const formats = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff' };
      const mime = Object.hasOwn(formats, ext) ? formats[ext] : null;
      if (!mime) { add(op, 'image', `Image format .${ext} skipped; convert to PNG/JPEG for portable PowerPoint/Storyline import.`); return; }
      used.add(o.image);
      if (!media.has(o.image)) { const name = `image${media.size + 1}.${ext}`; media.set(o.image, name); files[`ppt/media/${name}`] = fs.readFileSync(asset.src); imageTypes[ext] = mime; }
      const rid = `rId${rels.length + 1}`; rels.push({ id: rid, type: 'image', target: '../media/' + media.get(o.image) });
      if (o.style) add(op + '/style', 'style', 'Image styling is not exported; the image uses its object bounding box.');
      if (o.text || o.rich) add(op + '/text', 'text', 'Image text is not exported.');
      body += `<p:pic><p:nvPicPr><p:cNvPr id="${j + 3}" name="${xml(o.name ?? o.id)}" descr="${xml(o.alt ?? asset.asset.alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(o)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    });
    const background = color(s.background, 'FFFFFF', at + '/background', add);
    part(`ppt/slides/slide${n}.xml`, 'slide', `<p:sld ${NS}><p:cSld name="${xml(s.title)}"><p:bg><p:bgPr>${solid(background)}<a:effectLst/></p:bgPr></p:bg>${tree(body)}</p:cSld>${OVERRIDE}</p:sld>`);
    if (s.notes) {
      const notes = shape({ id: 'Notes', type: 'text', text: s.notes, x: 24, y: 360, w: 672, h: 500 }, 2, at + '/notes', add, [], 'body');
      part(`ppt/notesSlides/notesSlide${n}.xml`, 'notesSlide', `<p:notes ${NS}><p:cSld>${tree(notes)}</p:cSld>${OVERRIDE}</p:notes>`);
      files[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = relationships([{ id: 'rId1', type: 'notesMaster', target: '../notesMasters/notesMaster1.xml' }, { id: 'rId2', type: 'slide', target: `../slides/slide${n}.xml` }]);
      rels.push({ id: `rId${rels.length + 1}`, type: 'notesSlide', target: `../notesSlides/notesSlide${n}.xml` });
    }
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = relationships(rels);
  });
  d.assets.forEach((a, i) => { if (!used.has(a.id)) add(`/assets/${i}`, 'asset', 'Asset is not embedded in the PowerPoint deck.'); });
  part('ppt/presentation.xml', 'presentation.main', `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId3"/></p:notesMasterIdLst>' : ''}<p:sldIdLst>${slideIds.join('')}</p:sldIdLst><p:sldSz cx="${emu(d.size.w)}" cy="${emu(d.size.h)}" type="custom"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  part('ppt/presProps.xml', 'presProps', `<p:presentationPr ${NS}/>`);
  part('ppt/slideMasters/slideMaster1.xml', 'slideMaster', `<p:sldMaster ${NS}><p:cSld>${tree('')}</p:cSld>${MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`);
  part('ppt/slideLayouts/slideLayout1.xml', 'slideLayout', `<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${tree('')}</p:cSld>${OVERRIDE}</p:sldLayout>`);
  if (hasNotes) {
    part('ppt/notesMasters/notesMaster1.xml', 'notesMaster', `<p:notesMaster ${NS}><p:cSld>${tree('')}</p:cSld>${MAP}<p:notesStyle/></p:notesMaster>`);
    files['ppt/notesMasters/_rels/notesMaster1.xml.rels'] = relationships([{ id: 'rId1', type: 'theme', target: '../theme/theme1.xml' }]);
  }
  files['ppt/theme/theme1.xml'] = theme(); types['ppt/theme/theme1.xml'] = 'theme';
  files['ppt/_rels/presentation.xml.rels'] = relationships(presRels);
  files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = relationships([{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }, { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' }]);
  files['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = relationships([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]);
  files['_rels/.rels'] = relationships([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]);
  files['[Content_Types].xml'] = contentTypes(types, imageTypes);
  return writeExport(output, packageBytes(files, path.dirname(output)), issues, { slides: d.slides.length });
}
