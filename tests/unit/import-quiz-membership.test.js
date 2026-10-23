import test from 'node:test';
import assert from 'node:assert/strict';
import { importStory } from '../../packages/import-story/index.js';
import { openStory, saveStory } from '../../packages/export-story/save.js';
import { readZip } from '../../packages/import-story/zip-read.js';
import { G, ID, pkg, storyXml, slide, intr, choice, trig } from '../fixtures/synthetic/story-builder.js';

function fixture({ explicit = '', drawExclusion = '' } = {}) {
  const scene = (id, indices) => `<scene g="${G(id)}"><sldIdLst>${indices.map(i => `<sldId>R${i}</sldId>`).join('')}</sldIdLst></scene>`;
  const quiz = (id, result, list = '') => `<quiz g="${G(id)}" resultSldG="${G(result)}" passScore="80"><questionIdLst>${list}</questionIdLst></quiz>`;
  const story = storyXml().replace(/<sceneLst>[\s\S]*?<\/sceneLst>/, `<sceneLst>${scene(30,[1,2])}${scene(31,[3,4])}</sceneLst>`)
    .replace(/<bankLst>[\s\S]*?<\/bankLst>/, `<bankLst>${scene(32,[5,6])}</bankLst>`)
    .replace(/<quizLst>[\s\S]*?<\/quizLst>/, `<quizLst>${quiz(40,102,explicit)}${quiz(41,104)}</quizLst>`);
  const draw = (id, exc = '') => slide(id, { root: 'bankSld', attrs: `bankG="${G(32)}" incCnt="1" rnd="false"` }).replace('</bankSld>', `<excLst>${exc}</excLst></bankSld>`);
  const result = id => slide(id, { trigs: trig(id+1000,'OnStart','SubmitQuizSL',{blocks:`<customData g="${G(id)}"/>`}) });
  const question = id => slide(id, { shapes: intr('multiChoiceIntr', id*10) + choice('radio',id*10+1,id*10,'Yes',100,{selected:true}) + choice('radio',id*10+2,id*10,'No',200) });
  return pkg({story, parts:[draw(101,drawExclusion),result(102),draw(103),result(104),question(105),question(106)]});
}

test('default quiz membership stays in each draw/results scene and title saves preserve native membership bytes', () => {
  const bytes = fixture(), {doc,report} = importStory(bytes);
  assert.deepEqual(doc.quizzes.map(q=>q.questions), [[ID('s',101)],[ID('s',103)]]);
  assert.equal(report.items.some(i=>i.kind==='quiz.membership'),false);
  const prev=openStory(bytes); assert.ok(saveStory(prev,prev.doc).buf.equals(bytes));
  const next=structuredClone(prev.doc); next.title='Membership title edit';
  const saved=saveStory(prev,next), before=readZip(bytes), after=readZip(saved.buf);
  for(const name of before.names.filter(n=>n.startsWith('story/slides/'))) assert.ok(before.read(name).equals(after.read(name)));
  assert.deepEqual(openStory(saved.buf).doc.quizzes.map(q=>q.questions), [[ID('s',101)],[ID('s',103)]]);
});

test('explicit membership overrides scene defaults and draw exclusions apply to the draw itself', () => {
  const {doc}=importStory(fixture({explicit:`<id>${G(103)}</id><id>${G(102)}</id><id>${G(999)}</id>`}));
  assert.deepEqual(doc.quizzes.map(q=>q.questions), [[ID('s',101),ID('s',103)],[]]);
  const excluded=importStory(fixture({drawExclusion:`<id>${G(40)}</id>`}));
  assert.deepEqual(excluded.doc.quizzes.map(q=>q.questions), [[],[ID('s',103)]]);
});

test('another results slide bounds default membership within one scene', () => {
  const source=fixture(), zip=readZip(source), xml=zip.read('story/story.xml').toString();
  const scene=`<sceneLst><scene g="${G(30)}"><sldIdLst>${[1,2,3,4].map(i=>`<sldId>R${i}</sldId>`).join('')}</sldIdLst></scene></sceneLst>`;
  const story=xml.replace(/<sceneLst>[\s\S]*?<\/sceneLst>/,scene);
  const bytes=pkg({story,parts:zip.names.filter(n=>/^story\/slides\/[^/]+\.xml$/.test(n)).map(n=>zip.read(n).toString())});
  assert.deepEqual(importStory(bytes).doc.quizzes.map(q=>q.questions),[[ID('s',101)],[ID('s',103)]]);
});
