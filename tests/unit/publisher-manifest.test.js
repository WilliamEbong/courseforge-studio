import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { manifest } from '../../packages/publisher/scorm12-manifest.js';

const base = { id: 'demo-course', title: 'Demo', version: '1', files: ['index.html', 'cf-scorm.js', 'assets/a b.png'] };

// Independent XML parser (Python's ElementTree) checks well-formedness and structure. Null when python is missing.
const PY = `import sys, json, xml.etree.ElementTree as ET
r = ET.fromstring(sys.stdin.buffer.read())
cp = '{http://www.imsproject.org/xsd/imscp_rootv1p1p2}'
ad = '{http://www.adlnet.org/xsd/adlcp_rootv1p2}'
orgs = r.find(cp + 'organizations')
items = r.findall('.//' + cp + 'item')
res = r.findall('.//' + cp + 'resource')
print(json.dumps({'id': r.get('identifier'), 'default': orgs.get('default'), 'orgs': len(orgs), 'items': len(items),
  'title': items[0].find(cp + 'title').text, 'ref': items[0].get('identifierref'),
  'mastery': (items[0].find(ad + 'masteryscore').text if items[0].find(ad + 'masteryscore') is not None else None),
  'res': [[x.get('identifier'), x.get('type'), x.get(ad + 'scormtype'), x.get('href')] for x in res],
  'files': [f.get('href') for f in r.findall('.//' + cp + 'file')],
  'schemaversion': r.find(cp + 'metadata/' + cp + 'schemaversion').text}))`;
function parse(xml) {
  const r = spawnSync('python', ['-I', '-c', PY], { input: xml, encoding: 'utf8' });
  if (r.error) return null;
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('one organization, one item, one SCO resource; sorted encoded files', (t) => {
  const xml = manifest(base);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /xsi:schemaLocation="[^"]*imscp_rootv1p1p2\.xsd[^"]*adlcp_rootv1p2\.xsd"/);
  assert.doesNotMatch(xml, /masteryscore/);
  const m = parse(xml);
  if (!m) { t.skip('python not available for XML parse'); return; }
  assert.deepEqual(m, {
    id: 'demo-course', default: 'demo-course-org', orgs: 1, items: 1, title: 'Demo', ref: 'demo-course-sco', mastery: null,
    res: [['demo-course-sco', 'webcontent', 'sco', 'index.html']],
    files: ['assets/a%20b.png', 'cf-scorm.js', 'index.html'], schemaversion: '1.2',
  });
});

test('masteryscore when given; text is escaped and stays well-formed', (t) => {
  const title = 'Q&A <"Safety"> it\'s \u0001fine';
  const xml = manifest({ ...base, title, masteryScore: 80, files: ['index.html', 'x&y.js', 'sub\\dir.js'] });
  assert.match(xml, /<adlcp:masteryscore>80<\/adlcp:masteryscore>/);
  assert.match(xml, /Q&amp;A &lt;&quot;Safety&quot;&gt; it&apos;s fine/);
  const m = parse(xml);
  if (!m) { t.skip('python not available for XML parse'); return; }
  assert.equal(m.title, 'Q&A <"Safety"> it\'s fine');
  assert.equal(m.mastery, '80');
  assert.deepEqual(m.files, ['index.html', 'sub/dir.js', 'x&y.js']);
});

test('deterministic output regardless of file order and duplicates', () => {
  assert.equal(manifest(base), manifest({ ...base, files: [...base.files].reverse().concat('index.html') }));
});

test('input validation', () => {
  const bad = [
    [{ ...base, id: '1abc' }, /id/],
    [{ ...base, id: 'a b' }, /id/],
    [{ ...base, title: '  ' }, /title/],
    [{ ...base, version: '' }, /version/],
    [{ ...base, masteryScore: 101 }, /masteryScore/],
    [{ ...base, masteryScore: '80' }, /masteryScore/],
    [{ ...base, files: [] }, /files/],
    [{ ...base, files: ['../etc/passwd', 'index.html'] }, /relative/],
    [{ ...base, files: ['/abs.html', 'index.html'] }, /relative/],
    [{ ...base, files: ['C:/x.html', 'index.html'] }, /relative/],
    [{ ...base, launch: 'story.html' }, /launch/],
  ];
  for (const [args, re] of bad) assert.throws(() => manifest(args), (e) => e instanceof TypeError && re.test(e.message), JSON.stringify(args));
  assert.throws(() => manifest(), TypeError);
});
