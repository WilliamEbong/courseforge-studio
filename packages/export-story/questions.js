// Original question/quiz XML from (g8–g13 and scalar probes).
// The common shape, sheet and trigger scaffolds stay in elements.js.
import { el, ZERO, PLAYER_BUTTON } from './elements.js';
import { storyId } from '../import-story/index.js';

const TAG = { mc: 'multiChoiceIntr', mr: 'multiRespIntr', tf: 'trueFalseIntr' };
const INTERACTION_TYPE = { mc: 'Multiple Choice', mr: 'Multiple Response', tf: 'True/False' };
export const questionNavigation = enabled => ({ prev: !enabled, prevGesture: !enabled, next: !enabled, nextGesture: !enabled, submit: enabled,
  default: true, menu: true, res: true, glos: false, notes: false, seek: false, replay: false, play: true, search: false, ltBxClse: true });
const SCORE = [['scorePct', 'scorePercent', '$PercentScore'], ['scorePoints', 'scorePoints', '$Score'], ['passPoints', 'passPoints', '$PassScore'], ['passPct', 'passPercent', '$PassPercent']];
export function nativeAttempts(value = 1) {
  const values = ['unlimited', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  if (!Number.isInteger(value) || value < 0 || value > 10) throw Object.assign(new Error('Native questions support 1–10 attempts or unlimited; nothing was saved'), { errors: [{ code: 'story-unsupported', path: '/question/attempts', message: 'Use 1–10 attempts or 0 for unlimited' }] });
  return values[value];
}

export function questionElements({ size, resolve, T, doc }) {
  const textObject = (id, text, box, extra = {}) => ({ id, type: 'text', text, x: box.x, y: box.y, w: box.w, h: box.h, ...(box.style ? { style: box.style } : {}), states: {}, ...extra });
  const key = (slide, kind) => `native-question:${kind}:${slide.id}`;
  const refs = (ids) => ids.map(id => el('g', {}, resolve(id))).join('');
  const member = (quiz, slideId) => quiz.questions.includes(slideId) || quiz.questions.some(id => {
    const draw = doc.slides.find(s => s.id === id)?.draw;
    return draw && doc.banks.find(b => b.id === draw.bank)?.slides.includes(slideId);
  });
  const exclusions = slideId => refs(doc.quizzes.filter(q => !member(q, slideId)).map(q => q.id));
  function intrProps(s, q, titleId, feedback = {}) {
    return el('intrProps', {
      feedbk: 'intr', score: 'intr', branch: 'none', corPts: q.points ?? 0, incPts: 0,
      showCorFb: true, showIncFb: true, showTryFb: true, shuffle: q.shuffle ?? false,
      attempts: nativeAttempts(q.attempts), skip: false,
      max: 10, playBk: 'intr', defFb: false, showTip: true, subm: 'plyr', keys: 'None', revNav: true,
      incFbG: feedback.incorrect ? resolve(feedback.incorrect) : ZERO,
      corFbG: feedback.correct ? resolve(feedback.correct) : ZERO,
      tryFbG: feedback.tryAgain ? resolve(feedback.tryAgain) : ZERO,
      thankFbG: ZERO, resultFbG: ZERO, intrG: resolve(key(s, 'properties')),
      titleBoxG: titleId ? resolve(titleId) : ZERO, prevBtnG: ZERO, nextBtnG: ZERO,
      sndG: ZERO, reviewFbG: ZERO, mediaG: ZERO,
    }, el('tipText'), el('exclQuizLst', {}, exclusions(s.id)));
  }
  function panel(s, tag, children, attrs = {}, childIds = []) {
    return T.object(textObject(key(s, 'interaction'), '', { x: 0, y: 0, ...size }), 0, [], false, {
      tag, attrs: { allowDrop: false, hScroll: false,
        ansG: resolve(key(s, 'answers')), canDel: true, canCopy: true, ...attrs },
      childIds: refs(childIds), children: el('autoScrollMrgn', { w: 0, h: 0 }) + el('autoScrollPos', { x: 0, y: 0 }) + children,
    });
  }
  function feedbackLayer(s, kind, value, layerId) {
    const buttonId = key(s, kind + '-continue');
    const commands = [{ id: key(s, kind + '-hide'), on: { event: 'click', target: buttonId }, do: [{ action: 'hideLayer' }] }];
    if (kind !== 'tryAgain') commands.push({ id: key(s, kind + '-next'), on: { event: 'click', target: buttonId }, do: [{ action: 'jump', to: 'next' }] });
    const text = T.object(textObject(key(s, kind + '-text'), value, { x: size.w * .15, y: size.h * .3, w: size.w * .7, h: size.h * .2 }));
    const button = T.object(textObject(buttonId, 'Continue', { x: size.w * .35, y: size.h * .6, w: size.w * .3, h: 48 }, { type: 'button', style: { fill: '#2563eb' } }), 1, commands, false, { tag: 'feedBackBtn', attrs: { type: 'con', txtSet: false } });
    return T.sheet('feedBackLayer', { ...T.item(layerId), name: kind, defaultName: kind, choiceG: ZERO,
      modal: true, pause: true, stop: true, hideEnd: false, top: false, seek: 'n', seekInheritable: 'n', presentAs: 'Layer', resetMode: 'auto',
    }, { background: '#ffffff', objects: text + button });
  }
  function slideContents(s) {
    const q = s.question, quiz = doc.quizzes.find(qz => qz.results === s.id);
    if (q && TAG[q.type]) {
      const titleId = key(s, 'prompt'), feedback = Object.fromEntries(['correct', 'incorrect', 'tryAgain'].map(kind => [kind, key(s, kind + '-layer')]));
      const title = T.object(textObject(titleId, q.prompt, q.layout?.prompt ?? { x: size.w * .08, y: size.h * .08, w: size.w * .84, h: size.h * .18 }), 1);
      const choices = q.choices.map((c, i) => {
        const box = q.layout?.choices.find(p => p.id === c.id) ?? { x: size.w * .1, y: size.h * .3 + i * size.h * .1, w: size.w * .8, h: size.h * .08 };
        const choice = textObject(c.id, c.label, box), tag = q.type === 'mr' ? 'checkBox' : 'radio';
        const states = ['normal', 'hover', 'down', 'disabled', 'selected'].map(name => T.state(choice, name, {}, {
          tag, stateTag: q.type === 'mr' ? 'checkShapeState' : 'radioShapeState', attrs: { style: 'style1' },
          children: name === 'normal' ? el('btnBg', {}, T.style({ fill: '#ffffff', border: '#34449c', borderWidth: 1 }), el('foreClr', {}, el('srgbClr', { val: '34449C' }))) : '',
        })).join('');
        return T.object(choice, i + 2, [], false, { tag, states,
          attrs: { parentG: resolve(key(s, 'interaction')), style: 'style1', initState: c.correct ? 'Selected' : 'Normal',
            grpId: q.type === 'mr' ? undefined : resolve(key(s, 'choice-group')) },
          children: el('scoreData', { correct: c.correct, pts: 0, showFeedBk: false, shuffle: true, feedBkG: ZERO })
            + el('propBag', {}, el('prop', {}, el('key', {}, 'ParentInteractionType'), el('val', {}, el('str', {}, INTERACTION_TYPE[q.type])))),
        });
      }).join('');
      const submit = T.trigger({ id: key(s, 'submit'), on: { event: 'click' }, do: [{ action: 'submit' }] })
        .replace(el('interaction'), el('interaction', { submitG: resolve(key(s, 'interaction')) }))
        .replace(el('frame', { actionG: ZERO, restore: true }), el('frame', { actionG: PLAYER_BUTTON.submit, restore: true }));
      return {
        objects: panel(s, TAG[q.type], intrProps(s, q, titleId, feedback), { cfKey: 'score', ...(q.layout ? {} : { cfLayout: 'auto' }) }, q.choices.map(c => c.id)) + title + choices,
        triggers: submit,
        navigation: el('navData', questionNavigation(true)),
        layers: Object.entries(feedback).map(([kind, id]) => feedbackLayer(s, kind, q.feedback[kind], id)).join(''),
      };
    }
    if (quiz) {
      const result = kind => {
        const layer = s.layers.find(l => kind === 'success' ? /success|passed/i.test(l.title) : /failure|failed/i.test(l.title));
        const trigger = layer && s.triggers.find(t => t.do.some(a => a.action === 'showLayer' && a.layer === layer.id));
        return el(kind, { g: layer ? resolve(layer.id) : ZERO, trigG: trigger ? resolve(trigger.id) : ZERO });
      };
      return { objects: panel(s, 'rsltsIntr', intrProps(s, { attempts: 0 }) + el('choices') + result('success') + result('failure'), { quizG: resolve(quiz.id), attempts: 'unlimited', type: 'graded', new: true, glowType: 'accent5_15' }), triggers: '', layers: '' };
    }
    return { objects: '', triggers: '', layers: '' };
  }
  function bank(b) {
    const draw = doc.slides.find(s => s.draw?.bank === b.id);
    return el('scene', { ...T.item(b.id), name: b.title, desc: '', primaryId: ZERO, sceneType: 'scene', collapse: false, drawG: draw ? resolve(draw.id) : ZERO },
      el('sldIdLst', {}, b.slides.map(id => el('sldId', {}, 'R' + storyId(resolve(id))))), el('bankProps', { rand: false, include: -1 }));
  }
  function draw(s) {
    const d = s.draw, bank = doc.banks.find(b => b.id === d.bank);
    return { attrs: { bankG: resolve(d.bank), incCnt: d.count, rnd: d.shuffle, sync: false },
      tail: el('questionLst', {}, bank.slides.map(id => el('bankSld', { ...T.item(`bank-row:${s.id}:${id}`), link: 'none', exc: d.never.includes(id), inc: d.always.includes(id), sldG: resolve(id) })))
        + el('excLst', {}, refs(doc.quizzes.filter(q => !q.questions.includes(s.id)).map(q => q.id))),
    };
  }
  function quizManager() {
    return el('quizMgr', { ...T.item('native-quiz-manager'), ...tracking(), type: 'graded', showResult: true, finishAction: 'closeWnd', finishUrl: '' },
      el('bankLst', {}, doc.banks.map(bank)),
      el('quizLst', {}, doc.quizzes.map(quiz)));
  }
  function tracking() {
    const tracked = doc.tracking.complete.find(c => c.quiz)?.quiz, result = doc.quizzes.find(q => q.id === tracked)?.results;
    const viewed = doc.tracking.complete.find(c => c.slidesViewed !== undefined || c.slidesViewedCount !== undefined);
    const singleResult = result && doc.tracking.complete.length === 1 && Object.keys(doc.tracking.complete[0]).length === 1;
    return { lmsResultSlideG: result ? resolve(result) : ZERO,
      trackMode: viewed && result ? 'Slides, Results' : result ? 'result' : viewed ? 'slide' : 'none',
      slidesViewedNumber: viewed?.slidesViewedCount ?? viewed?.slidesViewed ?? 100,
      slidesViewedUnit: viewed?.slidesViewedCount !== undefined ? 'Count' : 'Percentage', totalSlidesSource: 'project',
      numView: viewed?.slidesViewedCount ?? -1, cfTrackingStatus: singleResult ? doc.tracking.status : '' };
  }
  function quiz(q) {
    return el('quiz', { ...T.item(q.id), name: q.title, timed: false, passScore: q.passPercent, timeLimit: 'PT1H', timerMode: 'course',
        ...Object.fromEntries(SCORE.map(([attr, field]) => [attr, resolve('var:' + q.id + '.' + field)])), passG: ZERO, resultSldG: q.results ? resolve(q.results) : ZERO,
        resultMode: 'qstn', mustPass: false, showcorrectincorrectinreview: true, reviewincorrectquestionsonly: false, resetincorrectquestionsonly: false, onlyScoreViewedQuestions: false, roundUpScorePercent: q.round,
      }, el('questionIdLst', {}, q.questions.map(id => el('id', {}, resolve(id)))), el('dataLst'));
  }
  function variables(ids = doc.quizzes.map(q => q.id)) {
    return doc.quizzes.filter(q => ids.includes(q.id)).flatMap(q => SCORE.map(([, field, suffix]) => el('var', { ...T.item('var:' + q.id + '.' + field), name: q.id + '.' + field, type: 'prop', dataType: 'num', val: 0, isRandom: false, propPath: `_player.${storyId(resolve(q.id))}.${suffix}` }))).join('');
  }
  return { slideContents, quizManager, quiz, bank, draw, variables, exclusions, tracking };
}
