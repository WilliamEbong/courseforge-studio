import test from 'node:test';
import assert from 'node:assert/strict';
import { writeStory } from '../../packages/export-story/index.js';
import { openStory, saveStory } from '../../packages/export-story/save.js';
import { applyAll } from '../../packages/core/index.js';
import { readZip } from '../../packages/import-story/zip-read.js';
import { rezip } from '../../packages/publisher/zip.js';
import { previewHtml } from '../../packages/publisher/index.js';
import { PRESETS } from '../../packages/schema/themes.js';
import { parseXml } from '../../packages/import-story/index.js';

test('native Player preview can enumerate the disabled logo option and its child values',()=>{
 const xml=readZip(writeStory()).read('story/playerProps.xml').toString();
 const root=parseXml(xml), find=(n,name)=>n.kids.find(k=>k.tag===name);
 const groups=find(find(root,'control_options'),'optiongroups');
 const sidebar=groups.kids.find(k=>k.attrs.name==='sidebaroptions');
 const logo=find(sidebar,'options').kids.find(k=>k.attrs.name==='logo_enabled');
 assert.ok(logo,'Player Properties dereferences logo_enabled even when no logo is shown');
 assert.equal(logo.attrs.value,'false');
 const children=find(logo,'options').kids;
 for(const name of ['logo_url','html5_logo_url']) assert.equal(children.find(k=>k.attrs.name===name)?.attrs.value,'');
});

test('native Modern player startup has an explicit bottom-bar options group',()=>{
 const root=parseXml(readZip(writeStory()).read('story/playerProps.xml').toString());
 const groups=root.kids.find(n=>n.tag==='control_options').kids.find(n=>n.tag==='optiongroups');
 const bottom=groups.kids.find(n=>n.attrs.name==='bottombaroptions');
 assert.ok(bottom,'Modern startup dereferences bottomBarOptions without a default');
 const enabled=bottom.kids.find(n=>n.tag==='options').kids.find(n=>n.attrs.name==='bottombar_enabled');
 assert.equal(enabled?.attrs.value,'true');
});

const edit = (s, args) => { const r=applyAll(s.doc,[{cmd:'player.set',args}]); assert.ok(r.ok,JSON.stringify(r.errors)); return saveStory(s,r.doc); };
test('new native course selects modern; style changes preserve opaque player settings and unrelated parts',()=>{
 let s=openStory(writeStory());
 assert.equal(s.doc.player.style,'modern');
 assert.match(s.zip.read('story/playerProps.xml').toString(), /<playerType>unified<\/playerType>/);
 const original=s.zip.read('story/playerProps.xml').toString().replace('</player>','<opaque keep="yes">preserve me</opaque></player>');
 s=openStory(rezip(s.buf,s.zip,{put:new Map([['story/playerProps.xml',Buffer.from(original)]])}));
 assert.equal(saveStory(s,s.doc).buf,s.buf);
 const classic=edit(s,{style:'classic'});
 assert.equal(classic.doc.player.style,'classic');
 assert.match(classic.zip.read('story/playerProps.xml').toString(), /<opaque keep="yes">preserve me<\/opaque>/);
 for(const name of s.zip.names) if(name!=='story/playerProps.xml') assert.deepEqual(classic.zip.read(name),s.zip.read(name),name);
 assert.equal(edit(classic,{style:'modern'}).doc.player.style,'modern');
});
test('old package with no player part keeps CF appearance until modern is explicitly selected',()=>{
 const buf=writeStory(), z=readZip(buf);
 const rel=z.read('story/_rels/story.xml.rels').toString().replace(/<Relationship\b[^>]*Id="rId5"[^>]*\/>/g,'');
 const old=openStory(rezip(buf,z,{drop:new Set(['story/playerProps.xml']),put:new Map([['story/_rels/story.xml.rels',Buffer.from(rel)]])}));
 assert.equal(old.doc.player.style,undefined);
 assert.equal(edit(old,{style:'modern'}).doc.player.style,'modern');
});
test('modern presentation reuses charcoal tokens, explicit overrides win, original document is unchanged',()=>{
 const s=openStory(writeStory()), doc=structuredClone(s.doc);
 doc.player.style='modern';doc.player.theme={accent:'#123456'};
 const before=structuredClone(doc), html=previewHtml(doc);
 assert.ok(html.includes(PRESETS.charcoal.tokens.bg));
 assert.match(html, /"accent":"#123456"/);
 assert.deepEqual(doc,before);
});
