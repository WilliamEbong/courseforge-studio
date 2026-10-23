import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importStory, textPointScale } from '../../packages/import-story/index.js';
import { validate } from '../../packages/schema/index.js';
import { G, ID, obj, slide, pkg, intr, choice, state, layer, trig, storyXml, esc } from '../fixtures/synthetic/story-builder.js';
import { createRuntime } from '../../packages/runtime/index.js';

// Synthetic structures from documented in.
test('exact slide-count tracking counts distinct visited flow slides and remains an alternative criterion', () => {
  const { doc } = importStory(pkg({ parts: [slide(101), slide(102), slide(103)] }));
  doc.tracking = { complete: [{ slidesViewed: 100 }, { slidesViewedCount: 2 }], status: 'completed-incomplete' };
  assert.deepEqual(validate(doc), []);
  const statuses = [];
  const rt = createRuntime(doc, { lms: { status: value => statuses.push(value) } });
  rt.start();
  rt.dispatch({ type: 'prev' });
  assert.deepEqual(statuses, []);
  rt.dispatch({ type: 'next' });
  assert.deepEqual(statuses, ['completed']);
  rt.dispatch({ type: 'prev' }).dispatch({ type: 'next' });
  assert.deepEqual(statuses, ['completed']);
  doc.tracking.complete = [{ slidesViewedCount: 0 }];
  assert.ok(validate(doc).some(e => e.path.includes('slidesViewedCount')));
});

test('native LMS state imports exact count plus all quizzes with enabled submit triggers', () => {
  const quiz = n => `<quiz g="${G(n)}" name="Quiz" passScore="80" resultSldG="${G(n + 100)}"><questionIdLst/></quiz>`;
  const state = '<state><reach360><lms reporting="CompletedIncomplete"/></reach360><lms reporting="PassedFailed"/></state>';
  const story = storyXml().replace('<propLst>', `<propLst><prop id="3">${esc(state)}</prop>`)
    .replace('<quizMgr>', `<quizMgr trackMode="Slides, Results" slidesViewedNumber="2" slidesViewedUnit="Count" totalSlidesSource="project" lmsResultSlideG="${G(140)}">`)
    .replace(/<quizLst>[\s\S]*?<\/quizLst>/, `<quizLst>${quiz(40)}${quiz(41)}${quiz(42)}</quizLst>`);
  const parts = [slide(101), ...[40, 41, 42].map(n => slide(n + 100, { trigs: trig(n + 1000, 'OnStart', 'SubmitQuizSL', { enabled: n === 42 ? 'false' : 'true', blocks: `<customData g="${G(n + 100)}"/>` }) }))];
  const { doc, report } = importStory(pkg({ story, parts }));
  assert.deepEqual(doc.tracking, { complete: [{ slidesViewedCount: 2 }, { quiz: ID('q', 40) }, { quiz: ID('q', 41) }], status: 'passed-failed' });
  assert.deepEqual(validate(doc), []);
  assert.equal(report.items.some(i => i.kind === 'tracking'), false);
  const malformed = importStory(pkg({ story: story.replace(esc(state), '&lt;state&gt;'), parts }));
  assert.equal(malformed.report.items.some(i => i.kind === 'tracking'), true);
  assert.equal(malformed.doc.tracking, undefined);
  const cloudOnly = importStory(pkg({ story: story.replace(esc(state), esc('<state><reach360><lms reporting="PassedFailed"/></reach360></state>')), parts }));
  assert.equal(cloudOnly.doc.tracking, undefined);
  const legacyResult = story.replace('trackMode="Slides, Results"', 'trackMode="result" cfTrackingStatus="completed-incomplete"');
  assert.deepEqual(importStory(pkg({ story: legacyResult, parts })).doc.tracking, {
    complete: [{ quiz: ID('q', 40) }, { quiz: ID('q', 41) }], status: 'passed-failed',
  });
  const legacySlide = story.replace('trackMode="Slides, Results"', 'trackMode="slide"');
  assert.deepEqual(importStory(pkg({ story: legacySlide, parts })).doc.tracking, doc.tracking);
});

test('native project Percentage and legacy Default use fixed scene flow without guessing a draw denominator', () => {
  const story = storyXml().replace('<propLst>', `<propLst><prop id="3">${esc('<state><lms reporting="CompletedFailed"/></state>')}</prop>`)
    .replace(/<bankLst>[\s\S]*?<\/bankLst>/, '<bankLst/>')
    .replace('<quizMgr>', '<quizMgr trackMode="slide" slidesViewedNumber="67" slidesViewedUnit="Percentage" totalSlidesSource="project">');
  const parts = [slide(101), slide(102), slide(103)];
  assert.deepEqual(importStory(pkg({ story, parts })).doc.tracking, { complete: [{ slidesViewed: 67 }], status: 'completed-failed' });
  const def = story.replace('trackMode="slide"', 'trackMode="def"').replace('slidesViewedNumber="67"', 'slidesViewedNumber="2"').replace('slidesViewedUnit="Percentage"', 'slidesViewedUnit="Count"');
  assert.deepEqual(importStory(pkg({ story: def, parts })).doc.tracking, { complete: [{ slidesViewedCount: 2 }], status: 'completed-failed' });
  const completion = importStory(pkg({ story: def, parts: [slide(101, { trigs: trig(701, 'OnStart', 'CompleteCourse') }), slide(102), slide(103)] }));
  assert.equal(completion.doc.tracking, undefined);
  assert.ok(completion.report.items.some(i => i.kind === 'tracking.flags'));
});

test('native Count clamps to the expanded scene flow instead of counting the whole bank pool', () => {
  const story = `<story id="${G(1)}"><propLst><prop id="3">${esc('<state><lms reporting="CompletedIncomplete"/></state>')}</prop><prop id="15"><sz w="720" h="540"/></prop></propLst>`
    + `<sceneLst><scene g="${G(30)}"><sldIdLst><sldId>R1</sldId><sldId>R2</sldId></sldIdLst></scene></sceneLst>`
    + `<quizMgr trackMode="Slides" slidesViewedNumber="3" slidesViewedUnit="Count" totalSlidesSource="project"><bankLst><scene g="${G(32)}"><sldIdLst><sldId>R3</sldId><sldId>R4</sldId><sldId>R5</sldId></sldIdLst></scene></bankLst><quizLst/></quizMgr></story>`;
  const parts = [slide(101), slide(102, { root: 'bankSld', attrs: `bankG="${G(32)}" incCnt="1" rnd="false"` }), slide(103), slide(104), slide(105)];
  const { doc } = importStory(pkg({ story, parts }));
  assert.deepEqual(doc.tracking.complete, [{ slidesViewedCount: 2 }]);
  const statuses = [], rt = createRuntime(doc, { lms: { status: s => statuses.push(s) } });
  rt.start(); rt.dispatch({ type: 'next' });
  assert.deepEqual(statuses, ['completed']);
});

test('font points scale with native project dimensions and its font-scaling version', () => {
  assert.equal(textPointScale({ w: 720, h: 540 }, true), 4 / 3);
  assert.equal(textPointScale({ w: 1920, h: 1080 }, true), 8 / 3);
  assert.equal(textPointScale({ w: 1920, h: 1080 }, false), 32 / 9);
  assert.equal(textPointScale({ w: 360, h: 270 }, false), 2 / 3);
  assert.equal(textPointScale({ w: 1440, h: 270 }, true), 4 / 3);
  const story = storyXml().replace('<story ', '<story UseNewFontScaling="true" ').replace('w="720" h="540"', 'w="1920" h="1080"');
  assert.equal(importStory(pkg({ story, parts: [slide(101)] })).textScale, 8 / 3);
});

test('specialized radio and checkbox states retain choice labels and correctness', () => {
  for (const [kind, tag, stateTag] of [['multiChoiceIntr', 'radio', 'radioShapeState'], ['multiRespIntr', 'checkBox', 'checkBoxShapeState']]) {
    const shapes = intr(kind, 210, { title: G(200) }) + obj('textBox', 200, { plain: 'Choose an answer' })
      + choice(tag, 211, 210, 'Choice one', 80, { selected: true }).replaceAll('<state ', `<${stateTag} `).replaceAll('</state>', `</${stateTag}>`)
      + choice(tag, 212, 210, 'Choice two', 140).replaceAll('<state ', `<${stateTag} `).replaceAll('</state>', `</${stateTag}>`);
    const { doc } = importStory(pkg({ parts: [slide(101, { shapes })] }));
    assert.deepEqual(validate(doc), []);
    assert.deepEqual(doc.slides[0].question.choices.map(c => [c.label, c.correct]), [['Choice one', true], ['Choice two', false]]);
  }
});

test('unnamed slides take their title placeholder text, while explicit names win', () => {
  const shapes = obj('textBox', 201, { plain: 'Authored title', extra: '<ph type="title"/>' });
  for (const name of ['', 'Explicit title']) {
    const { doc } = importStory(pkg({ parts: [slide(101, { name, shapes })] }));
    assert.equal(doc.slides[0].title, name || 'Authored title');
  }
});

test('button geometry takes the Normal artwork size at the outer slide position', () => {
  const states = state('Normal', 211, 'btn', { plain: 'Continue' }).replace('r="100" b="50"', 'r="484" b="55"');
  const shapes = obj('btn', 201, { at: [341, 519, 825, 676], states });
  const { doc } = importStory(pkg({ parts: [slide(101, { shapes })] }));
  const button = doc.slides[0].objects[0];
  assert.deepEqual([button.x, button.y, button.w, button.h], [341, 519, 484, 55]);
  assert.equal(button.text, 'Continue');
});

test('equal absolute native corner radii and standalone rectangle hotspots import directly', () => {
  const shapes = obj('btn', 201, { plain: 'Rounded', extra: '<rndC rTL="7" rTR="7" rBL="7" rBR="7" usePc="false"/>' })
    + obj('clkAreaRect', 202, { at: [30, 40, 130, 140] });
  const {doc} = importStory(pkg({parts:[slide(101,{shapes})]}));
  assert.equal(doc.slides[0].objects[0].style.radius,7);
  assert.equal(doc.slides[0].objects[1].type,'hotspot');
});

test('actual appearance fonts supply CSS defaults while cached resize values do not', () => {
  const shapes = obj('textBox', 201, { plain: 'Styled', fill: '<bG><defaultFont sz="18" name="Arial"/><foreClr><srgbClr val="123456"/></foreClr></bG>', extra: '<resize fontSz="99"/>' })
    + obj('textBox', 202, { plain: 'Unstyled', extra: '<resize fontSz="99"/>' });
  const { doc } = importStory(pkg({ parts: [slide(101, { shapes })] }));
  assert.deepEqual(doc.slides[0].objects[0].style, { fontSize: 24, fontFamily: 'Arial', color: '#123456', bold: false, italic: false });
  assert.deepEqual(doc.slides[0].objects[1].style, { fontSize: 16, bold: false, italic: false });
  const explicitColor = shapes.replace('<defaultFont sz="18" name="Arial"/>', '<defaultFont sz="18" name="Arial"><clr><srgbClr val="abcdef"/></clr></defaultFont>');
  assert.equal(importStory(pkg({ parts: [slide(101, { shapes: explicitColor })] })).doc.slides[0].objects[0].style.color, '#abcdef');
});

test('placeholder font inheritance uses the referenced layout placeholder before type defaults', () => {
  const shapes = obj('textBox', 201, { plain: 'Inherited', extra: `<ph g="${G(301)}" type="title"/>` });
  const extra = [
    ['story/slideLayouts/layout.xml', `<layout g="${G(90)}"><shapeLst>${obj('ph',301,{fill:'<bG><defaultFont sz="30" name="Arial"/></bG>',extra:'<ph type="body"/>'})}</shapeLst></layout>`],
    ['story/slideMasters/master.xml', '<master><layoutIdLst><sldId>RL</sldId></layoutIdLst></master>'],
    ['story/slideMasters/_rels/master.xml.rels', '<Relationships><Relationship Type="slideLayout" Id="RL" Target="/story/slideLayouts/layout.xml"/></Relationships>'],
  ];
  const {doc}=importStory(pkg({parts:[slide(101,{shapes,attrs:`layoutG="${G(90)}"`})],extra}));
  assert.deepEqual(doc.slides[0].objects[0].style,{fontSize:40,fontFamily:'Arial',bold:false,italic:false,textFit:{x:10,y:5,w:80,h:40,wrap:true}});
});

test('explicit layer revisit settings honor the inheritable override', () => {
  const layers=layer(300,{attrs:'resetMode="n" resetModeInheritable="y"'})+layer(301,{attrs:'resetMode="n"'});
  const {doc}=importStory(pkg({parts:[slide(101,{layers})]}));
  assert.deepEqual(doc.slides[0].layers.map(l=>l.revisit),['reset','resume']);
});

test('own omitted text defaults are suppressed only while their actual values match the encoded baseline', () => {
  const shapes = obj('textBox', 201, { plain: 'Baseline', attrs: 'cfTextDefaults="fontSize,fontFamily,color,bold,italic"', fill: '<bG><defaultFont sz="18" name="Segoe UI" style="Regular"/><foreClr><srgbClr val="1c1f24"/></foreClr></bG>' });
  assert.equal(importStory(pkg({ parts: [slide(101, { shapes })] })).doc.slides[0].objects[0].style, undefined);
  const changed = shapes.replace('sz="18"', 'sz="24"').replace('style="Regular"', 'style="Bold"');
  assert.deepEqual(importStory(pkg({ parts: [slide(101, { shapes: changed })] })).doc.slides[0].objects[0].style, { fontSize: 32, bold: true });
});

test('supported unused media remain in the library with their native XML node', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-fidelity-assets-'));
  try {
    const story = storyXml().replace('type="Png"', 'type="Png" cfAlt="Library description"');
    const { doc, nodes } = importStory(pkg({ story, parts: [slide(101)] }), { assetsDir: path.join(dir, 'assets'), courseDir: dir });
    assert.equal(doc.assets.length, 1);
    assert.equal(doc.assets[0].mime, 'image/png');
    assert.equal(doc.assets[0].alt, 'Library description');
    assert.equal(nodes.get(doc.assets[0].id).node.attrs.g, G(20));
    assert.ok(fs.existsSync(path.join(dir, doc.assets[0].path)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native attempt enumeration maps every bounded count and unlimited', () => {
  for (const [i, attempts] of ['unlimited', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].entries()) {
    const shapes = intr('multiChoiceIntr', 210, { title: G(200), attempts }) + obj('textBox', 200, { plain: 'Choose one' })
      + choice('radio', 211, 210, 'One', 150, { selected: true }) + choice('radio', 212, 210, 'Two', 230);
    assert.equal(importStory(pkg({ parts: [slide(101, { shapes })] })).doc.slides[0].question.attempts, i);
  }
});

test('choice questions retain authored prompt and option boxes through the runtime view', () => {
  const shapes = intr('multiChoiceIntr', 210, { title: G(200) })
    + obj('textBox', 200, { at: [60, 30, 660, 100], plain: 'Choose one' })
    + choice('radio', 211, 210, 'One', 150, { selected: true })
    + choice('radio', 212, 210, 'Two', 230);
  const { doc } = importStory(pkg({ parts: [slide(101, { shapes })] }));
  const layout = { prompt: { x: 60, y: 30, w: 600, h: 70, style: { fontSize: 16, bold: false, italic: false } }, choices: [
    { id: ID('c', 211), x: 100, y: 150, w: 500, h: 40, style: { fontSize: 16, bold: false, italic: false } },
    { id: ID('c', 212), x: 100, y: 230, w: 500, h: 40, style: { fontSize: 16, bold: false, italic: false } },
  ] };
  assert.deepEqual(doc.slides[0].question.layout, layout);
  const runtime = createRuntime(doc);
  runtime.dispatch({ type: 'start' });
  assert.deepEqual(runtime.view().question.layout, layout);
  doc.slides[0].question.layout.choices[1].id = 'missing-choice';
  assert.ok(validate(doc).some(e => e.path.endsWith('/question/layout/choices') && e.code === 'ref'));
  const generated = importStory(pkg({ parts: [slide(101, { shapes: shapes.replace('<multiChoiceIntr ', '<multiChoiceIntr cfLayout="auto" ') })] })).doc;
  assert.equal(generated.slides[0].question.layout, undefined);
});

test('own-file ID and score-key markers preserve arbitrary ids without guessing native initial states', () => {
  const shapes = intr('multiChoiceIntr', 210, { title: G(200), extraAttrs: 'cfKey="score"' })
    + obj('textBox', 200, { plain: 'Choose one', attrs: 'cfId="question-prompt"' })
    + choice('radio', 211, 210, 'One', 150, { scored: true }).replace('<radio ', '<radio cfId="answer-one" ')
    + choice('radio', 212, 210, 'Two', 230).replace('<radio ', '<radio cfId="answer-two" ');
  const { doc } = importStory(pkg({ parts: [slide(101, { shapes, attrs: 'cfId="first-slide"' })] }));
  assert.equal(doc.slides[0].id, 'first-slide');
  assert.deepEqual(doc.slides[0].question.choices.map(c => [c.id, c.correct]), [['answer-one', true], ['answer-two', false]]);
  const duplicate = obj('textBox', 201, { plain: 'One', attrs: 'cfId="shared-id"' }) + obj('textBox', 202, { plain: 'Two', attrs: 'cfId="shared-id"' });
  const d = importStory(pkg({ parts: [slide(101, { shapes: duplicate })] })).doc;
  assert.deepEqual(d.slides[0].objects.map(o => o.id), ['shared-id', 'shared-id-2']);
  const navigation = trig(500, 'OnNextButtonClick', 'jumpToSlide').replace('<trig ', '<trig cfId="authored-next" ');
  assert.equal(importStory(pkg({ parts: [slide(101, { trigs: navigation })] })).doc.slides[0].triggers[0].id, 'authored-next');
});

test('standard feedback title placeholders do not repeat the player heading; custom titles remain', () => {
  const shapes = intr('multiChoiceIntr', 210, { title: G(200), cor: G(300) }) + obj('textBox', 200, { plain: 'Choose one' })
    + choice('radio', 211, 210, 'One', 150, { selected: true }) + choice('radio', 212, 210, 'Two', 230);
  for (const title of ['Correct', 'Well done']) {
    const layers = layer(300, { tag: 'feedBackLayer', name: 'Correct', shapes:
      obj('feedbackTextBox', 301, { plain: title, extra: '<ph type="title"/>' })
      + obj('feedbackTextBox', 302, { plain: 'That is the answer.', extra: '<ph type="body"/>' }) });
    const q = importStory(pkg({ parts: [slide(101, { shapes, layers })] })).doc.slides[0].question;
    assert.equal(q.feedback.correct, (title === 'Correct' ? '' : title + '\n') + 'That is the answer.');
  }
});

test('freeform drag questions keep target-only rows and unassigned distractor items', () => {
  const missing = '01dfe22b-2e1c-4dc9-a514-a7d3f1ab7177';
  const body = `<choices><intrFreeChoice shpG="${G(201)}" matchShpG="${G(202)}"/><intrFreeChoice shpG="${missing}" matchShpG="${G(203)}"/><intrFreeChoice shpG="${G(204)}" matchShpG="${missing}"/></choices>`;
  const shapes = intr('dragDropIntr', 210, { body }) + [201,202,203,204].map(n=>obj('rect',n)).join('');
  const { doc } = importStory(pkg({ parts: [slide(101,{shapes})] }));
  assert.deepEqual(doc.slides[0].question.items, [{object:ID('o',201),target:ID('o',202)},{object:ID('o',204)}]);
  assert.deepEqual(doc.slides[0].question.targets.map(t=>t.object),[ID('o',202),ID('o',203)]);
  assert.deepEqual(validate(doc),[]);
});

test('simple native picture/text drag groups move their visible members together', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf-group-'));
  try {
    const body=`<choices><intrFreeChoice shpG="${G(201)}" matchShpG="${G(204)}"/></choices><dragDrop onlyOne="true"/>`;
    const shapes=intr('dragDropIntr',210,{body})+obj('group',201,{at:[20,30,220,130]})
      +obj('pic',202,{at:[20,30,100,110],attrs:`parentG="${G(201)}" assetG="${G(20)}"`})
      +obj('textBox',203,{at:[100,40,220,80],attrs:`parentG="${G(201)}"`,plain:'Move together'})
      +obj('rect',204,{at:[300,200,500,300]});
    const {doc}=importStory(pkg({parts:[slide(101,{shapes})]}),{assetsDir:path.join(dir,'assets'),courseDir:dir});
    const group=doc.slides[0].objects.find(o=>o.id===ID('o',201));
    assert.deepEqual(group.members,[ID('o',202),ID('o',203)]);
    assert.deepEqual(validate(doc),[]);
    const bad=structuredClone(doc);bad.slides[0].objects.find(o=>o.id===group.id).members.push(ID('o',202));
    assert.ok(validate(bad).some(e=>e.path.endsWith('/members')));
    const rt=createRuntime(doc);rt.dispatch({type:'start'});rt.dispatch({type:'drop',item:group.id,target:ID('o',204)});
    const picture=rt.view().objects.find(o=>o.id===ID('o',202)),text=rt.view().objects.find(o=>o.id===ID('o',203));
    assert.deepEqual([picture.x,picture.y,text.x,text.y],[300,200,380,210]);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
