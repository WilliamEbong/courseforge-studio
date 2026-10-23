// SCORM 1.2 imsmanifest.xml writer: one organization, one item, one SCO..
// XSDs are referenced by schemaLocation only, not bundled (plan 002 decision 2, risk R1).

const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const esc = (s) => String(s).replace(XML_ILLEGAL, '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function relPath(p) {
  if (typeof p !== 'string' || !p) throw new TypeError(`manifest: file path must be a non-empty string, got ${JSON.stringify(p)}`);
  const s = p.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').some((seg) => seg === '..' || seg === ''))
    throw new TypeError(`manifest: "${p}" must be a relative path inside the package`);
  return s;
}

export function manifest({ id, title, version, masteryScore, files, launch = 'index.html' } = {}) {
  if (typeof id !== 'string' || !NCNAME.test(id)) throw new TypeError(`manifest: id "${id}" must be an XML name (letter or _, then letters, digits, _ . -)`);
  if (typeof title !== 'string' || !title.trim()) throw new TypeError('manifest: title must be a non-empty string');
  if ((typeof version !== 'string' && typeof version !== 'number') || String(version) === '') throw new TypeError('manifest: version is required');
  if (masteryScore !== undefined && !(typeof masteryScore === 'number' && masteryScore >= 0 && masteryScore <= 100))
    throw new TypeError(`manifest: masteryScore must be a number 0-100, got ${JSON.stringify(masteryScore)}`);
  if (!Array.isArray(files) || !files.length) throw new TypeError('manifest: files must be a non-empty array of relative paths');
  const list = [...new Set(files.map(relPath))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const start = relPath(launch);
  if (!list.includes(start)) throw new TypeError(`manifest: launch "${launch}" is not in files`);
  const href = (p) => esc(encodeURI(p).replace(/[#?]/g, encodeURIComponent)); // encodeURI alone leaves # and ? raw
  const t = esc(title);
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${id}" version="${esc(version)}"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="${id}-org">
    <organization identifier="${id}-org">
      <title>${t}</title>
      <item identifier="${id}-item" identifierref="${id}-sco" isvisible="true">
        <title>${t}</title>${masteryScore === undefined ? '' : `
        <adlcp:masteryscore>${masteryScore}</adlcp:masteryscore>`}
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="${id}-sco" type="webcontent" adlcp:scormtype="sco" href="${href(start)}">
${list.map((f) => `      <file href="${href(f)}"/>`).join('\n')}
    </resource>
  </resources>
</manifest>
`;
}
