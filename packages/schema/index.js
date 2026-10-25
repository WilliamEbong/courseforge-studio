// Course document v1 ("cf.course/1"): shape, defaults, validation (shape + references + semantics), serialization.
import { check, applyDefaults, canonical, toJsonSchema } from './check.js';
import { migrate } from './migrate.js';

export const SCHEMA_VERSION = 'cf.course/1';
export const ID = '^[a-z][a-z0-9-]{0,40}$';
export const VAR_NAME = '^(?!__)[A-Za-z_][A-Za-z0-9_]*$';
export const BUILTIN_STATES = ['normal', 'hover', 'down', 'selected', 'visited', 'disabled', 'hidden'];
export const OBJECT_TYPES = ['text', 'shape', 'button', 'image', 'hotspot', 'input', 'slider', 'dial', 'video', 'audio', 'marker'];
export const MEDIA = new Set(['video', 'audio']);
export const INTERACTIVE = new Set(['button', 'hotspot', 'input', 'slider', 'dial', 'marker']);
/* * Slider/dial defaults. Not schema defaults: normalize would add them to every object. */
export const rangeOf = (o) => ({ min: o.min ?? 0, max: o.max ?? (o.type === 'dial' ? 12 : 10), step: o.step ?? 1 });

const id = { type: 'string', pattern: ID };
const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const value = { type: ['number', 'string', 'boolean'] };
const revisit = { type: 'string', enum: ['auto', 'reset', 'resume'], default: 'auto' };

const style = {
  type: 'object', additionalProperties: false, description: 'Visual overrides; colors are CSS hex like #0b6e6e.',
  properties: {
    fill: str, color: str, border: str, borderWidth: num, radius: num, fontSize: { type: 'number', minimum: 1 }, fontFamily: str,
    bold: bool, italic: bool, underline: bool, align: { type: 'string', enum: ['left', 'center', 'right'] }, valign: { type: 'string', enum: ['top', 'middle', 'bottom'] },
    opacity: { type: 'number', minimum: 0, maximum: 1 }, shadow: bool, padding: num, clip: bool,
    textFit: { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h', 'wrap'], properties: {
      x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
      w: { type: 'number', minimum: 0.01 }, h: { type: 'number', minimum: 0.01 }, wrap: bool,
    } },
  },
};

// one entrance and one exit effect per object. Visual only: visibility and triggers do not change.
const effectSchema = (when) => ({
  type: 'object', additionalProperties: false, required: ['effect'], description: when,
  properties: {
    effect: { type: 'string', enum: ['fade', 'fly', 'grow', 'zoom'] },
    duration: { type: 'number', minimum: 0.1, maximum: 5, default: 0.75, description: 'seconds' },
    direction: { type: 'string', enum: ['b', 'bl', 'l', 'tl', 't', 'tr', 'r', 'br'], description: 'fly only: the stage side the object enters from or exits to (default b)' },
  },
});

const rich = {
  type: 'array', description: 'Paragraphs; text mirrors their runs joined by newlines. Text/shape/button only.',
  items: { type: 'object', additionalProperties: false, required: ['runs'], properties: {
    runs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text'], properties: {
      text: str, b: bool, i: bool, u: bool, s: bool,
      color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, size: { type: 'number', minimum: 1 }, font: str,
      link: { type: 'string', pattern: '^(https?:|mailto:)' },
    } } },
    list: { type: 'string', enum: ['bullet', 'number'] }, level: { type: 'integer', minimum: 1, maximum: 5 },
    align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
  } },
};

export const objectSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'type'],
  properties: {
    id, type: { type: 'string', enum: OBJECT_TYPES },
    name: str,
    x: { type: 'number', default: 0 }, y: { type: 'number', default: 0 }, w: { type: 'number', minimum: 0, default: 200 }, h: { type: 'number', minimum: 0, default: 60 },
    rotation: { type: 'number', default: 0 },
    text: str, rich, style, image: id, alt: str,
    shape: { type: 'string', enum: ['rect', 'rounded', 'ellipse', 'line', 'arrow'], default: 'rect', description: 'line/arrow: a stroke along the box centre line from left to right (arrow: head at the right end), turned by rotation; stroke = style.border and style.borderWidth' },
    hidden: { type: 'boolean', default: false },
    locked: { type: 'boolean', description: 'editor only: the object cannot be dragged, resized or nudged on the canvas (imported master/layout objects)' },
    initialState: { type: 'string', default: 'normal' },
    states: { type: 'object', default: {}, values: { type: 'object', additionalProperties: false, properties: { style, text: str, image: id, hidden: bool } } },
    start: { type: 'number', minimum: 0, default: 0 }, end: { type: ['number', 'null'], default: null },
    enter: effectSchema('entrance effect: plays from the object start for its duration'),
    exit: effectSchema('exit effect: ends at the object end, starting at end - duration; ignored without an end'),
    var: { type: 'string', pattern: VAR_NAME, description: 'input: bound text variable; slider/dial: bound number variable (required)' },
    placeholder: str, tabIndex: { type: 'integer' },
    maxLength: { type: 'integer', minimum: 1, maximum: 1000, description: 'input: most characters the learner can type (default 400; SCORM 1.2 resume data holds 4096 characters for the whole course)' },
    report: { type: 'boolean', description: 'input: report the answer to the LMS as an ungraded fill-in interaction (result neutral, no score) when the learner leaves the slide; needs var' },
    min: { type: 'number', description: 'slider/dial: value at the start (default 0)' },
    max: { type: 'number', description: 'slider/dial: value at the end (default 10 for a slider, 12 for a dial)' },
    step: { type: 'number', description: 'slider/dial: values snap to min + n*step (default 1)' },
    live: { type: 'boolean', description: 'slider/dial: update the variable while dragging (default true) or on release' },
    startAngle: { type: 'number', description: 'dial: pointer angle at min, degrees clockwise from 12 o\'clock (default -90)' },
    endAngle: { type: 'number', description: 'dial: pointer angle at max (default 90)' },
    media: { ...id, description: 'video/audio: asset id of the media file (kept as is: mp4, webm, mp3, wav...)' },
    captions: { ...id, description: 'video/audio: asset id of a WebVTT (.vtt) captions file; captions start hidden (CC button, Ctrl+Alt+C)' },
    poster: { ...id, description: 'video: asset id of the poster image' },
    autoplay: { type: 'boolean', description: 'video/audio: play when the object appears (default false)' },
    controls: { type: 'boolean', description: 'video/audio: native player controls (default true); without them a click on a video plays or pauses it' },
    loop: { type: 'boolean', description: 'video/audio: repeat (default false); a looping medium never ends' },
    detail: { type: 'string', description: 'marker: the label text shown while the marker is open (text is its title)' },
    members: { type: 'array', items: id, description: 'Imported simple drag group: visible base-layer objects carried by this transparent hotspot.' },
  },
};

const clause = {
  type: 'object', additionalProperties: false,
  properties: {
    var: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_.-]*$' }, op: { type: 'string', enum: ['==', '!=', '<', '<=', '>', '>=', 'contains', 'notContains'] },
    value, otherVar: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_.-]*$' }, target: id, state: str, is: bool,
  },
};
export const condSchema = { type: 'object', additionalProperties: false, properties: { all: { type: 'array', items: clause }, any: { type: 'array', items: clause } } };

export const eventSchema = {
  type: 'object', additionalProperties: false,
  union: {
    key: 'event', map: {
      click: { required: ['target'], properties: { target: id }, description: 'learner clicks/activates an object (Enter/Space too)' },
      hoverEnter: { required: ['target'], properties: { target: id } },
      hoverLeave: { required: ['target'], properties: { target: id } },
      timelineStart: { properties: {}, description: 'the containing slide or layer timeline starts' },
      timelineEnd: { properties: {} },
      timeAt: { required: ['ms'], properties: { ms: { type: 'number', minimum: 0 } } },
      varChange: { required: ['var'], properties: { var: { type: 'string' } }, description: 'fires only when the value actually changes' },
      stateChange: { required: ['target', 'state'], properties: { target: id, state: str } },
      key: { required: ['key'], properties: { key: str } },
      playerNext: { properties: {}, description: 'replaces default Next navigation on this slide' },
      playerPrev: { properties: {} },
      mediaEnd: { required: ['target'], properties: { target: id }, description: 'a video or audio object finished playing' },
    },
  },
};

export const actionSchema = {
  type: 'object', additionalProperties: false,
  union: {
    key: 'action', map: {
      setVar: { required: ['var', 'op'], properties: { var: { type: 'string', pattern: VAR_NAME }, op: { type: 'string', enum: ['set', 'add', 'sub', 'mul', 'div', 'toggle'] }, value, fromVar: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_.-]*$' } } },
      setState: { required: ['target', 'state'], properties: { target: id, state: str } },
      showLayer: { required: ['layer'], properties: { layer: id } },
      hideLayer: { properties: { layer: id }, description: 'omit layer to hide the containing layer' },
      jump: { required: ['to'], properties: { to: str }, description: 'slide id, "next" or "prev"; ends remaining actions' },
      jumpScene: { required: ['to'], properties: { to: id } },
      submit: { properties: {}, description: 'submit the current question slide' },
      submitQuiz: { required: ['quiz'], properties: { quiz: id } },
      resetQuiz: { required: ['quiz'], properties: { quiz: id } },
      reviewQuiz: { required: ['quiz'], properties: { quiz: id }, description: 'after submitQuiz: step through the quiz read-only (answers and correct answers), then back to this slide' },
      completeCourse: { properties: {} },
      exitCourse: { properties: {} },
      openUrl: { required: ['url'], properties: { url: { type: 'string', pattern: '^(https?:|mailto:)' } } },
      pauseTimeline: { properties: {} },
      resumeTimeline: { properties: {} },
      setFocus: { required: ['target'], properties: { target: id } },
      playMedia: { required: ['target'], properties: { target: id }, description: 'play a video or audio object' },
      pauseMedia: { required: ['target'], properties: { target: id } },
      stopMedia: { required: ['target'], properties: { target: id }, description: 'pause and rewind to the start' },
    },
  },
};

export const triggerSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'on', 'do'],
  properties: { id, name: str, on: eventSchema, if: condSchema, do: { type: 'array', items: actionSchema }, else: { type: 'array', items: actionSchema }, enabled: { type: 'boolean', default: true } },
};

export const layerSchema = {
  type: 'object', additionalProperties: false, required: ['id'],
  properties: {
    id, title: { type: 'string', default: 'Layer' }, duration: { type: 'number', minimum: 0, default: 5000 },
    objects: { type: 'array', items: objectSchema, default: [] }, triggers: { type: 'array', items: triggerSchema, default: [] },
    hideOthers: { type: 'boolean', default: true }, hideBaseObjects: { type: 'boolean', default: false }, hideOnEnd: { type: 'boolean', default: false },
    modal: { type: 'boolean', default: false }, pauseBase: { type: 'boolean', default: false }, revisit,
  },
};

const questionBox = { x: num, y: num, w: { type: 'number', minimum: 1 }, h: { type: 'number', minimum: 1 }, style };
export const questionSchema = {
  type: 'object', additionalProperties: false, required: ['type', 'prompt'],
  properties: {
    type: { type: 'string', enum: ['mc', 'mr', 'tf', 'fill', 'hotspot', 'dragdrop', 'matching', 'sequence'], description: 'matching: rows, each answered with one of choices (a drop-down list per row); sequence: choices are the items in their correct order' }, prompt: str,
    layout: { type: 'object', additionalProperties: false, required: ['prompt', 'choices'], description: 'Authored choice-question boxes in slide coordinates; choices array is the visual slot order before shuffling.', properties: {
      prompt: { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'], properties: questionBox },
      choices: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'x', 'y', 'w', 'h'], properties: { id, ...questionBox } } },
    } },
    rows: {
      type: 'array', description: 'matching: statements; choice = id of the correct choice (several rows may share one)', items: {
        type: 'object', additionalProperties: false, required: ['id', 'label', 'choice'], properties: { id, label: str, choice: id },
      },
    },
    items: {
      type: 'array', description: 'dragdrop: drag items (base-layer objects of the slide); target = the correct target object, absent = distractor', items: {
        type: 'object', additionalProperties: false, required: ['object'], properties: { object: id, target: id },
      },
    },
    targets: {
      type: 'array', description: 'dragdrop: drop targets (base-layer objects); capacity one (default: centred, a new drop replaces the occupant) or many (stacked)', items: {
        type: 'object', additionalProperties: false, required: ['object'], properties: { object: id, capacity: { type: 'string', enum: ['one', 'many'] } },
      },
    },
    areas: {
      type: 'array', description: 'hotspot: click areas in slide coordinates; the first area containing the point decides', items: {
        type: 'object', additionalProperties: false, required: ['id', 'x', 'y', 'w', 'h'],
        properties: { id, shape: { type: 'string', enum: ['rect', 'ellipse'], description: 'default rect' }, x: num, y: num, w: { type: 'number', minimum: 1 }, h: { type: 'number', minimum: 1 }, correct: bool },
      },
    },
    choices: { type: 'array', default: [], items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id, label: str, correct: { type: 'boolean', default: false } } } },
    answers: { type: 'array', items: str, default: [] }, caseSensitive: { type: 'boolean', default: false },
    points: { type: 'number', minimum: 0, default: 10 }, attempts: { type: 'integer', minimum: 0, default: 1, description: '0 = unlimited (Storyline files store 10000)' }, shuffle: { type: 'boolean', default: true },
    feedback: { type: 'object', additionalProperties: false, default: { correct: 'Correct!', incorrect: 'Not quite.', tryAgain: 'Try again.' }, properties: { correct: str, incorrect: str, tryAgain: str } },
  },
};

// ---------- lessons mode (behavior source) ----------
/* * Block types a continue block can require (digest D [CONT]); a list counts only as a checkbox list. */
export const COMPLETABLE = new Set(['accordion', 'tabs', 'flashcards', 'labeledGraphic', 'process', 'video', 'audio', 'question', 'sorting', 'scenario', 'list:checkbox']);
export const isCompletable = (b) => COMPLETABLE.has(b.type === 'list' ? 'list:' + b.kind : b.type);
const assetRef = { type: 'string', pattern: ID, description: 'asset id' };
const itemList = (props, required) => ({ type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required, properties: props } });
const titled = itemList({ title: str, text: str }, ['title', 'text']);
const media = { required: ['media'], properties: { media: assetRef, captions: { ...assetRef, description: 'asset id of a WebVTT (.vtt) captions file' }, title: str } };
// Scenario (D [SCEN]): scene and item ids share one namespace per block; these words are reserved for goTo.
export const SCENARIO_GOTO = ['next', 'retry', 'end'];
const goTo = { type: 'string', description: 'next (default: the next item, then the next scene, then the end) | retry (restart this scene) | end | an item id | a scene id' };
const scenarioItem = {
  type: 'object', additionalProperties: false, required: ['id', 'kind', 'text'],
  properties: {
    id, kind: { type: 'string', enum: ['dialogue', 'text'], description: 'dialogue: the character speaks and the learner picks a response; text: narration with one Continue' }, text: str,
    responses: { type: 'array', minItems: 1, maxItems: 3, description: 'dialogue only', items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id, text: str, feedback: { type: 'string', description: 'shown before moving on' }, goTo } } },
    goTo: { ...goTo, description: `text only: ${goTo.description}` },
  },
};
const scenarioStarter = [{ id: 's1', title: 'Scene 1', items: [{ id: 'i1', kind: 'dialogue', text: 'What the character says.', responses: [
  { id: 'a', text: 'A good response', feedback: 'Why this works.', goTo: 'end' }, { id: 'b', text: 'A weaker response', feedback: 'Why this falls short.', goTo: 'retry' }] }] }];
export const BLOCK_TYPES = {
  heading: { required: ['text'], properties: { text: str, level: { type: 'integer', enum: [2, 3], default: 2 } } },
  text: { required: ['text'], properties: { text: str }, description: 'plain text; a blank line starts a new paragraph' },
  list: { required: ['items'], properties: { kind: { type: 'string', enum: ['bullet', 'numbered', 'checkbox'], default: 'bullet' }, items: { type: 'array', minItems: 1, items: str } } },
  quote: { required: ['text'], properties: { text: str, cite: str } },
  divider: { properties: {} },
  image: { required: ['image'], properties: { image: assetRef, alt: str, caption: str } },
  imageText: { required: ['image', 'text'], properties: { image: assetRef, alt: str, text: str, side: { type: 'string', enum: ['left', 'right'], default: 'left' } } },
  gallery: { required: ['items'], properties: { columns: { type: 'integer', enum: [2, 3, 4], default: 3 }, items: itemList({ image: assetRef, alt: str, caption: str }, ['image']) } },
  video: media,
  audio: media,
  accordion: { required: ['items'], properties: { items: titled } },
  tabs: { required: ['items'], properties: { items: titled } },
  flashcards: { required: ['items'], properties: { items: itemList({ front: str, back: str }, ['front', 'back']) } },
  labeledGraphic: { required: ['image', 'items'], properties: { image: assetRef, alt: str, items: itemList({ x: { type: 'number', minimum: 0, maximum: 100 }, y: { type: 'number', minimum: 0, maximum: 100 }, title: str, text: str }, ['x', 'y', 'title', 'text']) }, description: 'markers at x%/y% of the image' },
  process: { required: ['items'], properties: { intro: str, items: titled, summary: str } },
  timeline: { required: ['items'], properties: { items: itemList({ date: str, title: str, text: str }, ['title', 'text']) } },
  button: { required: ['label'], properties: { label: str, text: str, url: { type: 'string', pattern: '^(https?:|mailto:)' }, toLesson: id }, description: 'exactly one of url (opens a new tab) or toLesson (a lesson id)' },
  continue: { properties: { label: str, require: { type: 'string', enum: ['none', 'above', 'allAbove'], default: 'none' } }, description: 'hides the blocks below until passed' },
  question: {
    required: ['kind', 'prompt'], description: 'knowledge check (ungraded) or, in a quiz lesson, a graded question',
    properties: {
      kind: { type: 'string', enum: ['mc', 'mr', 'fill', 'matching'] }, prompt: str,
      choices: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id, label: str, correct: { type: 'boolean', default: false }, feedback: { type: 'string', description: 'mc only: shown when this choice is submitted' } } } },
      answers: { type: 'array', items: str }, caseSensitive: bool,
      pairs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['left', 'right'], properties: { left: str, right: str } } },
      feedback: { type: 'object', additionalProperties: false, properties: { correct: str, incorrect: str, any: str } },
      attempts: { type: 'integer', minimum: 0, description: 'knowledge checks: submissions allowed, 0 or absent = unlimited' },
      hideCorrect: bool, shuffle: bool,
    },
  },
  sorting: { required: ['categories', 'items'], properties: { categories: { type: 'array', minItems: 1, maxItems: 4, items: str }, items: itemList({ text: { type: 'string', maxLength: 80 }, category: { type: 'integer', minimum: 0, description: 'index into categories' } }, ['text', 'category']) } },
  scenario: {
    description: 'branching dialogue: scenes of dialogue items (1 to 3 responses) and text items; complete when an end is reached. Omit scenes for a one-scene starter.',
    properties: {
      scenes: {
        type: 'array', minItems: 1, default: scenarioStarter,
        items: { type: 'object', additionalProperties: false, required: ['id', 'items'], properties: {
          id, title: { type: 'string', description: 'for authors only; learners never see it' },
          background: assetRef, backgroundAlt: str, character: { ...assetRef, description: 'asset id of the character image' }, characterAlt: str,
          items: { type: 'array', minItems: 1, items: scenarioItem },
        } },
      },
      ending: { type: 'string', description: 'text shown at the end, above Start over' },
    },
  },
};
export const blockStyle = {
  type: 'object', additionalProperties: false, description: 'Block layout and colors (CSS hex colors).',
  properties: {
    width: { type: 'string', enum: ['narrow', 'normal', 'wide', 'full'] }, padding: { type: 'string', enum: ['none', 'small', 'normal', 'large'] },
    align: { type: 'string', enum: ['left', 'center', 'right'] }, background: str, color: str,
  },
};
export const blockSchema = { type: 'object', additionalProperties: false, required: ['id'], properties: { id, style: blockStyle }, union: { key: 'type', map: BLOCK_TYPES } };
export const QUIZ_FIELDS = ['passPercent', 'attempts', 'reveal', 'randomize', 'shuffle', 'requirePass'];
export const lessonSchema = {
  type: 'object', additionalProperties: false, required: ['id'],
  properties: {
    id, title: { type: 'string', default: 'Untitled lesson' }, kind: { type: 'string', enum: ['content', 'quiz'], default: 'content' },
    blocks: { type: 'array', items: blockSchema, default: [] },
    passPercent: { type: 'number', minimum: 0, maximum: 100, description: 'quiz: pass mark %, default 80' },
    attempts: { type: 'integer', minimum: 0, description: 'quiz: attempts allowed, default 0 = unlimited' },
    reveal: { type: 'string', enum: ['all', 'incorrect', 'none'], description: 'quiz: after each answer show result+feedback+correct answer (all, default), result+feedback (incorrect) or nothing (none)' },
    randomize: { type: 'boolean', description: 'quiz: random question order' }, shuffle: { type: 'boolean', description: 'quiz: shuffle answer choices' },
    requirePass: { type: 'boolean', description: 'quiz: the lesson completes only when passed' },
  },
};
export const sectionSchema = { type: 'object', additionalProperties: false, required: ['id'], properties: { id, title: { type: 'string', default: 'Section' }, lessons: { type: 'array', items: lessonSchema, default: [] } } };

/* * a draw slide stands in the flow for `count` slides picked from one question bank. */
export const drawSchema = {
  type: 'object', additionalProperties: false, required: ['bank'], description: 'question draw: the slide stands for count slides picked from a bank when the learner reaches it',
  properties: {
    bank: id, count: { type: 'integer', minimum: 0, default: 0, description: 'slides drawn; 0 = every eligible slide' },
    shuffle: { type: 'boolean', default: true, description: 'true: random order (pick order); false: bank order' },
    always: { type: 'array', items: id, default: [], description: 'bank slides always included' },
    never: { type: 'array', items: id, default: [], description: 'bank slides never included' },
  },
};

export const slideSchema = {
  type: 'object', additionalProperties: false, required: ['id'],
  properties: {
    id, title: { type: 'string', default: 'Untitled slide' }, duration: { type: 'number', minimum: 0, default: 5000 },
    advance: { type: 'string', enum: ['user', 'auto'], default: 'user' }, revisit, background: str, notes: str,
    objects: { type: 'array', items: objectSchema, default: [] }, layers: { type: 'array', items: layerSchema, default: [] },
    triggers: { type: 'array', items: triggerSchema, default: [] }, question: questionSchema, draw: drawSchema,
  },
};

export const courseSchema = {
  type: 'object', additionalProperties: false, required: ['schema', 'id', 'title'],
  properties: {
    schema: { type: 'string', const: SCHEMA_VERSION }, id, title: str, description: str, language: { type: 'string', default: 'en' },
    mode: { type: 'string', enum: ['slides', 'lessons'], default: 'slides', description: 'slides: scenes/slides/triggers; lessons: sections/lessons/blocks' },
    cover: { type: 'object', additionalProperties: false, description: 'lessons mode cover page image', properties: { image: assetRef, alt: str } },
    size: { type: 'object', additionalProperties: false, default: { w: 1280, h: 720 }, properties: { w: { type: 'number', minimum: 100 }, h: { type: 'number', minimum: 100 } } },
    player: {
      type: 'object', additionalProperties: false, default: { menu: true, prevNext: true, resume: 'prompt' },
      properties: {
        style: { type: 'string', enum: ['modern', 'classic'], description: 'Native player selection; modern uses CF charcoal chrome unless theme tokens override it' },
        menu: bool, prevNext: bool, resume: { type: 'string', enum: ['prompt', 'always', 'never'] }, theme: { type: 'object', values: str },
        navigation: { type: 'string', enum: ['free', 'restricted'], description: 'lessons mode: free (default) or restricted (in sequence; no search)' },
      },
    },
    variables: { type: 'array', default: [], items: { type: 'object', additionalProperties: false, required: ['name', 'type'], properties: { name: { type: 'string', pattern: VAR_NAME }, type: { type: 'string', enum: ['number', 'boolean', 'text'] }, initial: value } } },
    scenes: { type: 'array', default: [], items: { type: 'object', additionalProperties: false, required: ['id'], properties: { id, title: { type: 'string', default: 'Scene' }, slides: { type: 'array', items: id, default: [] } } } },
    banks: { type: 'array', default: [], description: 'question banks: slides kept outside the flow, reached through draw slides', items: { type: 'object', additionalProperties: false, required: ['id'], properties: { id, title: { type: 'string', default: 'Question bank' }, slides: { type: 'array', items: id, default: [] } } } },
    slides: { type: 'array', items: slideSchema, default: [] },
    quizzes: { type: 'array', default: [], items: { type: 'object', additionalProperties: false, required: ['id'], properties: { id, title: { type: 'string', default: 'Quiz' }, questions: { type: 'array', items: id, default: [] }, passPercent: { type: 'number', minimum: 0, maximum: 100, default: 80 }, results: id, round: { type: 'boolean', default: false, description: 'round the score % to a whole number (Storyline\'s "Round score percentage" quiz setting)' } } } },
    sections: { type: 'array', items: sectionSchema, default: [] },
    tracking: {
      type: 'object', additionalProperties: false, default: { complete: [{ slidesViewed: 100 }], status: 'completed-incomplete' },
      properties: {
        complete: { type: 'array', default: [{ slidesViewed: 100 }], items: { type: 'object', additionalProperties: false, properties: { slidesViewed: { type: 'number', minimum: 1, maximum: 100 }, slidesViewedCount: { type: 'integer', minimum: 1, description: 'Exact number of distinct learner-flow slides viewed' }, lessonsViewed: { type: 'number', minimum: 1, maximum: 100 }, quiz: id } } },
        status: { type: 'string', enum: ['passed-incomplete', 'passed-failed', 'completed-incomplete', 'completed-failed'], default: 'completed-incomplete' },
      },
    },
    assets: { type: 'array', default: [], items: { type: 'object', additionalProperties: false, required: ['id', 'path'], properties: { id, path: str, mime: str, alt: str } } },
  },
};

/** Return a deep copy with defaults applied (the in-memory working form). */
export function normalize(doc) {
  return fillDefaults(structuredClone(doc));
}
/** Apply defaults in place (no copy); for working copies that are already private. */
export function fillDefaults(d) {
  // A lessons course without completion criteria tracks lessons, not slides.
  if (d && d.mode === 'lessons' && !(d.tracking && d.tracking.complete)) d.tracking = { ...d.tracking, complete: [{ lessonsViewed: 100 }] };
  applyDefaults(courseSchema, d);
  // Normalize every entry path (commands, reusable slides, files), guarding malformed agent input for validate().
  for (const s of Array.isArray(d?.slides) ? d.slides : []) {
    const hosts = [s, ...(Array.isArray(s?.layers) ? s.layers : [])];
    for (const h of hosts) for (const o of Array.isArray(h?.objects) ? h.objects : []) {
      if (Array.isArray(o?.rich) && o.rich.every(p => Array.isArray(p?.runs) && p.runs.every(r => typeof r?.text === 'string'))) {
        o.text = o.rich.map(p => p.runs.map(r => r.text).join('')).join('\n');
      }
    }
  }
  return d;
}

const ptr = (...parts) => '/' + parts.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

/** Full validation: shape, then ids/references/semantics. Returns [] when valid. */
export function validate(doc) {
  const errs = check(courseSchema, doc);
  if (errs.length || !doc) return errs;
  const d = normalize(doc);
  const where = new Map(); // id -> path of declaration
  const dupe = (idv, path) => { if (where.has(idv)) errs.push({ path, code: 'dupe', message: `id "${idv}" already used at ${where.get(idv)}`, hint: 'ids must be unique across the whole course' }); else where.set(idv, path); };
  const vars = new Map(d.variables.map((v) => [v.name, v]));
  d.variables.forEach((v, i) => {
    if (d.variables.findIndex((w) => w.name === v.name) !== i) errs.push({ path: ptr('variables', i, 'name'), code: 'dupe', message: `variable "${v.name}" defined twice` });
    if (v.initial !== undefined && typeof v.initial !== { number: 'number', boolean: 'boolean', text: 'string' }[v.type]) errs.push({ path: ptr('variables', i, 'initial'), code: 'type', message: `initial value must be a ${v.type}` });
  });
  dupe(d.id, '/id');
  d.scenes.forEach((s, i) => dupe(s.id, ptr('scenes', i)));
  d.banks.forEach((b, i) => dupe(b.id, ptr('banks', i)));
  d.assets.forEach((a, i) => dupe(a.id, ptr('assets', i)));
  d.quizzes.forEach((q, i) => dupe(q.id, ptr('quizzes', i)));
  const slideIds = new Set();
  d.slides.forEach((s, i) => {
    dupe(s.id, ptr('slides', i)); slideIds.add(s.id);
    s.objects.forEach((o, j) => dupe(o.id, ptr('slides', i, 'objects', j)));
    s.layers.forEach((l, j) => { dupe(l.id, ptr('slides', i, 'layers', j)); l.objects.forEach((o, k) => dupe(o.id, ptr('slides', i, 'layers', j, 'objects', k))); });
    s.triggers.forEach((t, j) => dupe(t.id, ptr('slides', i, 'triggers', j)));
    s.layers.forEach((l, j) => l.triggers.forEach((t, k) => dupe(t.id, ptr('slides', i, 'layers', j, 'triggers', k))));
    if (s.question) s.question.choices.forEach((c, j) => { if (s.question.choices.findIndex((x) => x.id === c.id) !== j) errs.push({ path: ptr('slides', i, 'question', 'choices', j, 'id'), code: 'dupe', message: `choice id "${c.id}" repeated` }); });
  });
  const list = (ids) => [...ids].slice(0, 12).join(', ') || '(none)';
  const assetIds = new Set(d.assets.map((a) => a.id));
  // scene membership
  const seen = new Map();
  d.scenes.forEach((sc, i) => sc.slides.forEach((sid, j) => {
    if (!slideIds.has(sid)) errs.push({ path: ptr('scenes', i, 'slides', j), code: 'ref', message: `slide "${sid}" not found`, hint: `existing slides: ${list(slideIds)}` });
    else if (seen.has(sid)) errs.push({ path: ptr('scenes', i, 'slides', j), code: 'dupe', message: `slide "${sid}" is already in scene "${seen.get(sid)}"` });
    else seen.set(sid, sc.id);
  }));
  // bank slides are ordinary slides listed by a bank instead of a scene (never both)
  const bankOf = new Map();
  d.banks.forEach((b, i) => b.slides.forEach((sid, j) => {
    if (!slideIds.has(sid)) errs.push({ path: ptr('banks', i, 'slides', j), code: 'ref', message: `slide "${sid}" not found`, hint: `existing slides: ${list(slideIds)}` });
    else if (seen.has(sid)) errs.push({ path: ptr('banks', i, 'slides', j), code: 'dupe', message: `slide "${sid}" is already in ${bankOf.has(sid) ? 'bank' : 'scene'} "${seen.get(sid)}"`, hint: 'move it with slide.move {id, bank|scene}' });
    else { seen.set(sid, b.id); bankOf.set(sid, b.id); }
  }));
  d.slides.forEach((s, i) => { if (!seen.has(s.id)) errs.push({ path: ptr('slides', i), code: 'semantic', message: `slide "${s.id}" is not in any scene`, hint: 'add it with scene.set or slide.add {scene}, or to a bank with slide.add {bank}' }); });
  d.slides.forEach((s, i) => {
    const w = s.draw;
    if (!w) return;
    const wp = (...x) => ptr('slides', i, 'draw', ...x);
    if (bankOf.has(s.id)) errs.push({ path: wp(), code: 'semantic', message: `draw slide "${s.id}" is in bank "${bankOf.get(s.id)}"`, hint: 'draw slides belong in a scene: slide.move {id, scene}' });
    if (s.objects.length || s.layers.length || s.triggers.length || s.question) errs.push({ path: ptr('slides', i), code: 'semantic', message: `draw slide "${s.id}" has content of its own`, hint: 'a draw slide has no objects, layers, triggers or question; put them on the bank slides' });
    const bank = d.banks.find((b) => b.id === w.bank);
    if (!bank) { errs.push({ path: wp('bank'), code: 'ref', message: `bank "${w.bank}" not found`, hint: `banks: ${list(d.banks.map((b) => b.id))}; add one with bank.add` }); return; }
    const inBank = new Set(bank.slides);
    for (const k of ['always', 'never']) w[k].forEach((sid, j) => { if (!inBank.has(sid)) errs.push({ path: wp(k, j), code: 'ref', message: `slide "${sid}" is not in bank "${bank.id}"`, hint: `bank slides: ${list(inBank)}` }); });
    const both = w.always.filter((x) => w.never.includes(x));
    if (both.length) errs.push({ path: wp('never'), code: 'semantic', message: `slides both always and never included: ${both.join(', ')}`, hint: 'remove them from always or never' });
    if (w.count > 0 && w.always.length > w.count) errs.push({ path: wp('always'), code: 'range', message: `always lists ${w.always.length} slides but count is ${w.count}`, hint: `raise count to ${w.always.length} or more, or use count 0 (all)` });
  });
  const varRef = (name, path) => {
    if (vars.has(name)) return;
    if (/^[a-z][a-z0-9-]*\.(scorePercent|scorePoints|passPoints|passPercent|passed)$/.test(name) && d.quizzes.some((q) => name.startsWith(q.id + '.'))) return;
    errs.push({ path, code: 'ref', message: `variable "${name}" not defined`, hint: `defined: ${list(vars.keys())}` });
  };
  d.slides.forEach((s, i) => {
    const sp = ['slides', i];
    const objIds = new Set([...s.objects, ...s.layers.flatMap((l) => l.objects)].map((o) => o.id));
    const layerIds = new Set(s.layers.map((l) => l.id));
    const objects = [...s.objects.map((o, j) => [o, ptr(...sp, 'objects', j)]), ...s.layers.flatMap((l, j) => l.objects.map((o, k) => [o, ptr(...sp, 'layers', j, 'objects', k)]))];
    for (const [o, op] of objects) {
      if (o.rich && !['text', 'shape', 'button'].includes(o.type)) errs.push({ path: op + '/rich', code: 'semantic', message: 'rich text is supported on text, shape and button objects only' });
      if (o.image && !assetIds.has(o.image)) errs.push({ path: op + '/image', code: 'ref', message: `asset "${o.image}" not found`, hint: `assets: ${list(assetIds)}` });
      for (const [k, st] of Object.entries(o.states || {})) if (st.image && !assetIds.has(st.image)) errs.push({ path: `${op}/states/${k}/image`, code: 'ref', message: `asset "${st.image}" not found`, hint: `assets: ${list(assetIds)}` });
      if (o.type === 'image' && !o.image) errs.push({ path: op + '/image', code: 'required', message: 'image objects need an image asset id' });
      if (o.type === 'input' && o.var) { if (!vars.has(o.var)) varRef(o.var, op + '/var'); else if (vars.get(o.var).type !== 'text') errs.push({ path: op + '/var', code: 'type', message: `input must bind a text variable; "${o.var}" is ${vars.get(o.var).type}` }); }
      for (const k of ['maxLength', 'report']) if (o[k] !== undefined && o.type !== 'input') errs.push({ path: `${op}/${k}`, code: 'semantic', message: `${k} applies to input objects only` });
      if (o.type === 'input' && o.report && !o.var) errs.push({ path: op + '/report', code: 'required', message: `input ${o.id} reports its answer but stores it in no variable`, hint: `object.set {"id":"${o.id}","var":"<text variable>"}` });
      if (o.type === 'slider' || o.type === 'dial') {
        const numVars = () => `number variables: ${list([...vars.values()].filter((v) => v.type === 'number').map((v) => v.name))}; add one with var.add`;
        if (!o.var) errs.push({ path: op + '/var', code: 'required', message: `${o.type} objects need var (a number variable)`, hint: numVars() });
        else if (!vars.has(o.var)) varRef(o.var, op + '/var');
        else if (vars.get(o.var).type !== 'number') errs.push({ path: op + '/var', code: 'type', message: `${o.type} must bind a number variable; "${o.var}" is ${vars.get(o.var).type}`, hint: numVars() });
        const r = rangeOf(o);
        if (!(r.min < r.max)) errs.push({ path: op + '/max', code: 'range', message: `max (${r.max}) must be greater than min (${r.min})` });
        if (!(r.step > 0)) errs.push({ path: op + '/step', code: 'range', message: 'step must be greater than 0' });
        if (o.type === 'dial' && (o.startAngle ?? -90) === (o.endAngle ?? 90)) errs.push({ path: op + '/endAngle', code: 'range', message: 'endAngle must differ from startAngle' });
      }
      for (const k of ['media', 'captions', 'poster']) if (o[k] && !assetIds.has(o[k])) errs.push({ path: `${op}/${k}`, code: 'ref', message: `asset "${o[k]}" not found`, hint: `assets: ${list(assetIds)}; register files with asset.add` });
      if (MEDIA.has(o.type) && !o.media) errs.push({ path: op + '/media', code: 'required', message: `${o.type} objects need media (an asset id)`, hint: 'asset.add {"path":"assets/clip.mp4"} first' });
      const capAsset = o.captions && d.assets.find((a) => a.id === o.captions);
      if (capAsset && !/\.vtt$/i.test(capAsset.path)) errs.push({ path: op + '/captions', code: 'type', message: `captions must be a WebVTT file (.vtt); "${capAsset.path}" is not`, hint: 'convert SRT to WebVTT first' });
      const stateNames = new Set([...BUILTIN_STATES, ...Object.keys(o.states || {})]);
      if (!stateNames.has(o.initialState)) errs.push({ path: op + '/initialState', code: 'ref', message: `state "${o.initialState}" not defined`, hint: `states: ${list(stateNames)}` });
      for (const k of Object.keys(o.states || {})) if (!BUILTIN_STATES.includes(k) && !/^[a-z][a-z0-9_-]*$/.test(k)) errs.push({ path: `${op}/states/${k}`, code: 'pattern', message: 'custom state names must be lowercase identifiers' });
      if (o.end !== null && o.end < o.start) errs.push({ path: op + '/end', code: 'range', message: 'end must be >= start' });
    }
    const objById = new Map(objects.map(([o]) => [o.id, o]));
    const groupMembers = new Set();
    for (const [o, op] of objects) if (o.members) {
      if (o.type !== 'hotspot' || !s.objects.includes(o) || !o.members.length || new Set(o.members).size !== o.members.length || o.members.some(id => id === o.id || groupMembers.has(id) || !s.objects.some(child => child.id === id && !child.members))) errs.push({ path: op + '/members', code: 'ref', message: 'drag group members must be distinct ungrouped base-layer objects' });
      for (const id of o.members) groupMembers.add(id);
    }
    const badState = (target, state) => objById.has(target) && !BUILTIN_STATES.includes(state) && !Object.hasOwn(objById.get(target).states || {}, state);
    const stateHint = (target) => `states of ${target}: ${[...BUILTIN_STATES, ...Object.keys(objById.get(target)?.states || {})].join(', ')}`;
    const checkTriggers = (triggers, base, inLayer) => triggers.forEach((t, j) => {
      const tp = (...x) => ptr(...base, 'triggers', j, ...x);
      const on = t.on;
      if (on.target && !objIds.has(on.target)) errs.push({ path: tp('on', 'target'), code: 'ref', message: `object "${on.target}" not on this slide`, hint: `objects: ${list(objIds)}` });
      if (on.event === 'varChange') varRef(on.var, tp('on', 'var'));
      const mediaIds = () => `media objects: ${list(objects.filter(([o]) => MEDIA.has(o.type)).map(([o]) => o.id))}`;
      if (on.event === 'mediaEnd' && objById.has(on.target) && !MEDIA.has(objById.get(on.target).type)) errs.push({ path: tp('on', 'target'), code: 'semantic', message: `mediaEnd needs a video or audio object; "${on.target}" is ${objById.get(on.target).type}`, hint: mediaIds() });
      if (on.event === 'stateChange' && badState(on.target, on.state)) errs.push({ path: tp('on', 'state'), code: 'ref', message: `state "${on.state}" not defined on ${on.target}`, hint: stateHint(on.target) });
      for (const c of [...(t.if?.all || []), ...(t.if?.any || [])]) {
        const ci = (t.if.all || t.if.any).indexOf(c);
        const cp = (...x) => tp('if', t.if.all ? 'all' : 'any', ci, ...x);
        if (c.var !== undefined) { varRef(c.var, cp('var')); if (!c.op) errs.push({ path: cp('op'), code: 'required', message: 'op is required with var' }); if (c.value === undefined && c.otherVar === undefined) errs.push({ path: cp('value'), code: 'required', message: 'value or otherVar is required' }); if (c.otherVar) varRef(c.otherVar, cp('otherVar')); }
        else if (c.target !== undefined) { if (!objIds.has(c.target)) errs.push({ path: cp('target'), code: 'ref', message: `object "${c.target}" not on this slide`, hint: `objects: ${list(objIds)}` }); if (!c.state) errs.push({ path: cp('state'), code: 'required', message: 'state is required with target' }); else if (badState(c.target, c.state)) errs.push({ path: cp('state'), code: 'ref', message: `state "${c.state}" not defined on ${c.target}`, hint: stateHint(c.target) }); }
        else errs.push({ path: cp(), code: 'semantic', message: 'a condition needs var (+op,value) or target (+state)' });
      }
      if (t.if && t.if.all && t.if.any) errs.push({ path: tp('if'), code: 'semantic', message: 'use either all or any, not both' });
      [['do', t.do], ['else', t.else || []]].forEach(([key, acts]) => acts.forEach((a, k) => {
        const ap = (...x) => tp(key, k, ...x);
        if (a.target && !objIds.has(a.target)) errs.push({ path: ap('target'), code: 'ref', message: `object "${a.target}" not on this slide`, hint: `objects: ${list(objIds)}` });
        if (a.action === 'setState' && badState(a.target, a.state)) errs.push({ path: ap('state'), code: 'ref', message: `state "${a.state}" not defined on ${a.target}`, hint: stateHint(a.target) });
        if (/^(play|pause|stop)Media$/.test(a.action) && objById.has(a.target) && !MEDIA.has(objById.get(a.target).type)) errs.push({ path: ap('target'), code: 'semantic', message: `${a.action} needs a video or audio object; "${a.target}" is ${objById.get(a.target).type}`, hint: mediaIds() });
        if (a.layer && !layerIds.has(a.layer)) errs.push({ path: ap('layer'), code: 'ref', message: `layer "${a.layer}" not on this slide`, hint: `layers: ${list(layerIds)}` });
        if (a.action === 'hideLayer' && !a.layer && !inLayer) errs.push({ path: ap('layer'), code: 'required', message: 'hideLayer outside a layer needs layer' });
        if (a.action === 'jump' && !['next', 'prev'].includes(a.to) && !slideIds.has(a.to)) errs.push({ path: ap('to'), code: 'ref', message: `slide "${a.to}" not found`, hint: `use next, prev or one of: ${list(slideIds)}` });
        if (a.action === 'jumpScene' && !d.scenes.some((x) => x.id === a.to)) errs.push({ path: ap('to'), code: 'ref', message: `scene "${a.to}" not found` });
        if (['submitQuiz', 'resetQuiz', 'reviewQuiz'].includes(a.action) && !d.quizzes.some((q) => q.id === a.quiz)) errs.push({ path: ap('quiz'), code: 'ref', message: `quiz "${a.quiz}" not found`, hint: `quizzes: ${list(d.quizzes.map((q) => q.id))}` });
        if (a.action === 'submit' && !s.question) errs.push({ path: ap(), code: 'semantic', message: 'submit only works on a question slide' });
        if (a.action === 'setVar') {
          varRef(a.var, ap('var'));
          const v = vars.get(a.var);
          if (a.fromVar) varRef(a.fromVar, ap('fromVar'));
          if (v && a.op !== 'toggle' && a.value === undefined && a.fromVar === undefined) errs.push({ path: ap('value'), code: 'required', message: `value or fromVar is required for op "${a.op}"` });
          if (v && a.op === 'toggle' && v.type !== 'boolean') errs.push({ path: ap('op'), code: 'semantic', message: 'toggle only applies to boolean variables' });
          if (v && ['add', 'sub', 'mul', 'div'].includes(a.op) && v.type !== 'number') errs.push({ path: ap('op'), code: 'semantic', message: `${a.op} only applies to number variables` });
          if (v && a.op === 'set' && a.value !== undefined && typeof a.value !== { number: 'number', boolean: 'boolean', text: 'string' }[v.type]) errs.push({ path: ap('value'), code: 'type', message: `"${a.var}" is ${v.type}; value must match` });
        }
      }));
    });
    checkTriggers(s.triggers, sp, false);
    s.layers.forEach((l, j) => checkTriggers(l.triggers, [...sp, 'layers', j], true));
    const q = s.question;
    if (q) {
      if (q.layout && (!['mc', 'mr', 'tf'].includes(q.type) || q.layout.choices.length !== q.choices.length || new Set(q.layout.choices.map(c => c.id)).size !== q.choices.length || q.layout.choices.some(c => !q.choices.some(x => x.id === c.id)))) errs.push({ path: ptr(...sp, 'question', 'layout', 'choices'), code: 'ref', message: 'authored layout must list every choice exactly once on a choice question' });
      const nCorrect = q.choices.filter((c) => c.correct).length;
      if ((q.type === 'mc' || q.type === 'tf') && nCorrect !== 1) errs.push({ path: ptr(...sp, 'question', 'choices'), code: 'semantic', message: `${q.type} questions need exactly one correct choice (found ${nCorrect})` });
      if (q.type === 'mr' && nCorrect < 1) errs.push({ path: ptr(...sp, 'question', 'choices'), code: 'semantic', message: 'mr questions need at least one correct choice' });
      if (['mc', 'mr', 'tf'].includes(q.type) && q.choices.length < 2) errs.push({ path: ptr(...sp, 'question', 'choices'), code: 'semantic', message: 'choice questions need at least two choices' });
      if (q.type === 'hotspot') {
        const areas = q.areas || [];
        const ap = ptr(...sp, 'question', 'areas');
        if (!areas.length || areas.length > 25) errs.push({ path: ap, code: 'semantic', message: `hotspot questions need 1 to 25 areas (found ${areas.length})`, hint: 'SCORM 1.2 choice responses are single letters: one per area plus one for "outside"' });
        else if (!areas.some((a) => a.correct)) errs.push({ path: ap, code: 'semantic', message: 'hotspot questions need at least one correct area', hint: 'set correct:true on an area' });
        areas.forEach((a, j) => { if (areas.findIndex((x) => x.id === a.id) !== j) errs.push({ path: ptr(...sp, 'question', 'areas', j, 'id'), code: 'dupe', message: `area id "${a.id}" repeated` }); });
      }
      if (q.type === 'matching') {
        const rows = q.rows || [];
        const cids = new Set(q.choices.map((c) => c.id));
        if (!rows.length || rows.length > 10) errs.push({ path: ptr(...sp, 'question', 'rows'), code: 'semantic', message: `matching questions need 1 to 10 rows (found ${rows.length})`, hint: 'SCORM 1.2 matching sources are single digits (0-9)' });
        if (!q.choices.length || q.choices.length > 26) errs.push({ path: ptr(...sp, 'question', 'choices'), code: 'semantic', message: `matching questions need 1 to 26 choices (found ${q.choices.length})`, hint: 'SCORM 1.2 matching targets are single letters (a-z)' });
        rows.forEach((r, j) => {
          if (rows.findIndex((x) => x.id === r.id) !== j) errs.push({ path: ptr(...sp, 'question', 'rows', j, 'id'), code: 'dupe', message: `row id "${r.id}" repeated` });
          if (!cids.has(r.choice)) errs.push({ path: ptr(...sp, 'question', 'rows', j, 'choice'), code: 'ref', message: `choice "${r.choice}" not found`, hint: `choices: ${list(cids)}` });
        });
      }
      if (q.type === 'sequence' && (q.choices.length < 2 || q.choices.length > 26)) errs.push({ path: ptr(...sp, 'question', 'choices'), code: 'semantic', message: `sequence questions need 2 to 26 items (found ${q.choices.length})`, hint: 'list the choices in their correct order' });
      if (q.type === 'dragdrop') {
        const items = q.items || [], targets = q.targets || [];
        const qp = (...x) => ptr(...sp, 'question', ...x);
        const base = new Set(s.objects.map((o) => o.id));
        const baseHint = `base-layer objects: ${list(base)}`;
        if (!items.length || items.length > 10) errs.push({ path: qp('items'), code: 'semantic', message: `drag-and-drop questions need 1 to 10 items (found ${items.length})`, hint: 'SCORM 1.2 matching sources are single digits (0-9)' });
        if (!targets.length || targets.length > 26) errs.push({ path: qp('targets'), code: 'semantic', message: `drag-and-drop questions need 1 to 26 targets (found ${targets.length})`, hint: 'SCORM 1.2 matching targets are single letters (a-z)' });
        const seenObj = new Map();
        const own = (o, path) => {
          if (!base.has(o)) errs.push({ path, code: 'ref', message: `object "${o}" is not on this slide's base layer`, hint: baseHint });
          else if (seenObj.has(o)) errs.push({ path, code: 'dupe', message: `object "${o}" is already used at ${seenObj.get(o)}`, hint: 'each object is one item or one target' });
          else seenObj.set(o, path);
        };
        items.forEach((it, j) => own(it.object, qp('items', j, 'object')));
        targets.forEach((t, j) => own(t.object, qp('targets', j, 'object')));
        const tset = new Set(targets.map((t) => t.object));
        items.forEach((it, j) => { if (it.target !== undefined && !tset.has(it.target)) errs.push({ path: qp('items', j, 'target'), code: 'ref', message: `target "${it.target}" is not one of this question's targets`, hint: `targets: ${list(tset)}` }); });
        if (items.length && !items.some((it) => it.target)) errs.push({ path: qp('items'), code: 'semantic', message: 'at least one item needs a correct target', hint: 'items without target are distractors' });
      }
      if (q.type === 'fill' && q.answers.length < 1) errs.push({ path: ptr(...sp, 'question', 'answers'), code: 'semantic', message: 'fill questions need at least one acceptable answer' });
    }
  });
  d.quizzes.forEach((q, i) => {
    q.questions.forEach((sid, j) => {
      const s = d.slides.find((x) => x.id === sid); const qp = ptr('quizzes', i, 'questions', j);
      if (!s) errs.push({ path: qp, code: 'ref', message: `slide "${sid}" not found` });
      else if (bankOf.has(sid)) errs.push({ path: qp, code: 'semantic', message: `slide "${sid}" is in bank "${bankOf.get(sid)}"`, hint: `list the draw slide instead: ${list(d.slides.filter((x) => x.draw?.bank === bankOf.get(sid)).map((x) => x.id))}` });
      else if (!s.question && !s.draw) errs.push({ path: qp, code: 'semantic', message: `slide "${sid}" has no question` });
    });
    if (q.results && !slideIds.has(q.results)) errs.push({ path: ptr('quizzes', i, 'results'), code: 'ref', message: `slide "${q.results}" not found` });
  });
  validateLessons(d, errs, dupe, assetIds, list);
  const lessonsMode = d.mode === 'lessons';
  const quizIds = lessonsMode ? d.sections.flatMap((s) => s.lessons).filter((l) => l.kind === 'quiz').map((l) => l.id) : d.quizzes.map((q) => q.id);
  const [viewed, other] = lessonsMode ? ['lessonsViewed', 'slidesViewed'] : ['slidesViewed', 'lessonsViewed'];
  (d.tracking.complete || []).forEach((c, i) => {
    if (c.quiz && !quizIds.includes(c.quiz)) errs.push({ path: ptr('tracking', 'complete', i, 'quiz'), code: 'ref', message: `${lessonsMode ? 'quiz lesson' : 'quiz'} "${c.quiz}" not found`, hint: `${lessonsMode ? 'quiz lessons' : 'quizzes'}: ${list(quizIds)}` });
    if (c[other] !== undefined) errs.push({ path: ptr('tracking', 'complete', i, other), code: 'semantic', message: `${other} does not apply to a ${d.mode} course`, hint: `use ${viewed}` });
    else if (lessonsMode && c.slidesViewedCount !== undefined) errs.push({ path: ptr('tracking', 'complete', i, 'slidesViewedCount'), code: 'semantic', message: 'slidesViewedCount does not apply to a lessons course', hint: 'use lessonsViewed' });
    else if (!c.quiz && c[viewed] === undefined && (lessonsMode || c.slidesViewedCount === undefined)) errs.push({ path: ptr('tracking', 'complete', i), code: 'semantic', message: `criterion needs ${viewed}${lessonsMode ? '' : ', slidesViewedCount'} or quiz` });
  });
  return errs;
}

function validateLessons(d, errs, dupe, assetIds, list) {
  const err = (path, code, message, hint) => errs.push({ path, code, message, ...(hint ? { hint } : {}) });
  const lessonIds = new Set(d.sections.flatMap((s) => s.lessons.map((l) => l.id)));
  const asset = (ref, path) => { if (ref !== undefined && !assetIds.has(ref)) err(path, 'ref', `asset "${ref}" not found`, `assets: ${list(assetIds)} (register files with asset.add)`); };
  asset(d.cover?.image, '/cover/image');
  d.sections.forEach((s, i) => {
    dupe(s.id, ptr('sections', i));
    s.lessons.forEach((l, j) => {
      const lp = ptr('sections', i, 'lessons', j);
      dupe(l.id, lp);
      if (l.kind !== 'quiz') for (const k of QUIZ_FIELDS) if (l[k] !== undefined) err(`${lp}/${k}`, 'semantic', `${k} only applies to quiz lessons`, `lesson.set {"id":"${l.id}","kind":"quiz"} or {"id":"${l.id}","${k}":null}`);
      l.blocks.forEach((b, k) => {
        const bp = `${lp}/blocks/${k}`;
        dupe(b.id, bp);
        if (l.kind === 'quiz' && b.type !== 'question') err(bp, 'semantic', `quiz lessons hold only question blocks (found ${b.type})`, 'move it to a content lesson with block.move');
        for (const key of ['image', 'media', 'captions']) asset(b[key], `${bp}/${key}`);
        if (b.type === 'gallery') b.items.forEach((x, n) => asset(x.image, `${bp}/items/${n}/image`));
        const cap = b.captions !== undefined && d.assets.find((a) => a.id === b.captions);
        if (cap && !/\.vtt$/i.test(cap.path)) err(`${bp}/captions`, 'semantic', `captions must be a WebVTT file (got ${cap.path})`, 'register a .vtt file with asset.add');
        if (b.type === 'button' && (b.url === undefined) === (b.toLesson === undefined)) err(bp, 'semantic', 'a button needs exactly one of url or toLesson', `lessons: ${list(lessonIds)}`);
        if (b.toLesson !== undefined && !lessonIds.has(b.toLesson)) err(`${bp}/toLesson`, 'ref', `lesson "${b.toLesson}" not found`, `lessons: ${list(lessonIds)}`);
        if (b.type === 'continue') {
          const since = [];
          for (let n = k - 1; n >= 0 && l.blocks[n].type !== 'continue'; n--) since.push(l.blocks[n]);
          if (b.require === 'above' && !(since[0] && isCompletable(since[0]))) err(`${bp}/require`, 'semantic', `"above" needs a completable block directly above (found ${since[0]?.type ?? 'none'})`, `completable: ${[...COMPLETABLE].join(', ')}`);
          if (b.require === 'allAbove' && !since.some(isCompletable)) err(`${bp}/require`, 'semantic', '"allAbove" needs at least one completable block since the previous continue block', `completable: ${[...COMPLETABLE].join(', ')}`);
        }
        if (b.type === 'sorting') b.items.forEach((x, n) => { if (x.category >= b.categories.length) err(`${bp}/items/${n}/category`, 'range', `category ${x.category} does not exist`, `use 0..${b.categories.length - 1}`); });
        if (b.type === 'scenario') validateScenario(b, bp, err, asset, list);
        if (b.type !== 'question') return;
        const choices = b.choices || [];
        const nCorrect = choices.filter((c) => c.correct).length;
        if ((b.kind === 'mc' || b.kind === 'mr') && choices.length < 2) err(`${bp}/choices`, 'semantic', 'choice questions need at least two choices');
        if (b.kind === 'mc' && nCorrect !== 1) err(`${bp}/choices`, 'semantic', `mc questions need exactly one correct choice (found ${nCorrect})`);
        if (b.kind === 'mr' && nCorrect < 1) err(`${bp}/choices`, 'semantic', 'mr questions need at least one correct choice');
        choices.forEach((c, n) => {
          if (choices.findIndex((x) => x.id === c.id) !== n) err(`${bp}/choices/${n}/id`, 'dupe', `choice id "${c.id}" repeated`);
          if (c.feedback !== undefined && b.kind !== 'mc') err(`${bp}/choices/${n}/feedback`, 'semantic', 'per-choice feedback is for mc questions only', 'use feedback {correct, incorrect}');
        });
        if (b.kind === 'fill' && !(b.answers || []).length) err(`${bp}/answers`, 'semantic', 'fill questions need at least one acceptable answer');
        if (b.kind === 'matching' && !((b.pairs || []).length >= 2 && b.pairs.length <= 10)) err(`${bp}/pairs`, 'semantic', 'matching questions need 2 to 10 pairs');
      });
    });
  });
}

/* * Where a scenario goTo leads from item `it`: an item, null for the end, undefined for an unknown target. */
export function scenarioStep(b, it, to = 'next') {
  const scene = b.scenes.find((s) => s.items.includes(it));
  if (to === 'end') return null;
  if (to === 'retry') return scene.items[0]; // [ours] restart the scene
  if (to === 'next') { const flat = b.scenes.flatMap((s) => s.items); return flat[flat.indexOf(it) + 1] ?? null; } // [ours] then the next scene, then the end
  const s = b.scenes.find((x) => x.id === to);
  return s ? s.items[0] : b.scenes.flatMap((x) => x.items).find((x) => x.id === to);
}

function validateScenario(b, bp, err, asset, list) {
  let bad = false;
  const e = (...a) => { bad = true; err(...a); };
  const ids = new Set();
  const items = [];
  b.scenes.forEach((s, i) => {
    const sp = `${bp}/scenes/${i}`;
    for (const [x, p] of [[s, sp], ...s.items.map((it, j) => [it, `${sp}/items/${j}`])]) {
      if (SCENARIO_GOTO.includes(x.id)) e(`${p}/id`, 'semantic', `"${x.id}" is reserved for goTo`, 'pick another id');
      else if (ids.has(x.id)) e(`${p}/id`, 'dupe', `id "${x.id}" already used in this scenario`, 'scene and item ids are unique within the block');
      else ids.add(x.id);
    }
    asset(s.background, `${sp}/background`);
    asset(s.character, `${sp}/character`);
    s.items.forEach((it, j) => items.push([it, `${sp}/items/${j}`]));
  });
  const go = (g, p) => { if (g !== undefined && !SCENARIO_GOTO.includes(g) && !ids.has(g)) e(p, 'ref', `goTo "${g}" is not a scene or item of this scenario`, `use ${SCENARIO_GOTO.join(', ')} or one of: ${list(ids)}`); };
  for (const [it, p] of items) {
    if (it.kind === 'dialogue') {
      if (!it.responses) e(`${p}/responses`, 'required', 'dialogue items need 1 to 3 responses', '[{"id":"a","text":"...","goTo":"next"}]');
      if (it.goTo !== undefined) e(`${p}/goTo`, 'semantic', 'a dialogue item goes where its responses say', `set goTo on each response, or {"goTo":null}`);
    } else if (it.responses) e(`${p}/responses`, 'semantic', 'text items have one Continue, not responses', 'use kind "dialogue", or set goTo on the text item');
    (it.responses || []).forEach((r, k) => {
      if (it.responses.findIndex((x) => x.id === r.id) !== k) e(`${p}/responses/${k}/id`, 'dupe', `response id "${r.id}" repeated`, 'response ids are unique within their item (a, b, c)');
      go(r.goTo, `${p}/responses/${k}/goTo`);
    });
    go(it.goTo, `${p}/goTo`);
  }
  if (bad) return;
  // [ours] some path from the first item must reach an end, or the block could never complete (and would trap a gate)
  const seen = new Set();
  const todo = [b.scenes[0].items[0]];
  while (todo.length) {
    const it = todo.pop();
    if (seen.has(it)) continue;
    seen.add(it);
    for (const g of it.kind === 'dialogue' ? it.responses.map((r) => r.goTo) : [it.goTo]) {
      const n = scenarioStep(b, it, g);
      if (n === null) return;
      todo.push(n);
    }
  }
  err(`${bp}/scenes`, 'semantic', 'no path from the first item reaches the end', 'give a response or text item goTo "end", or "next" on the last item of the last scene');
}

/** Deterministic JSON text: canonical key order, defaults omitted, 2-space indent, trailing newline. */
export function serialize(doc) {
  return JSON.stringify(canonical(courseSchema, doc), null, 2) + '\n';
}

/** Parse JSON text into a normalized, validated doc. Throws {errors} on failure. */
export function parse(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw Object.assign(new Error('invalid JSON: ' + e.message), { errors: [{ path: '/', code: 'json', message: e.message }] }); }
  raw = migrate(raw); // older versions are upgraded first; newer ones are refused with a hint (A2)
  const errors = validate(raw);
  if (errors.length) throw Object.assign(new Error(`invalid course: ${errors.length} error(s)`), { errors });
  return normalize(raw);
}

/** Minimal valid course. */
export function emptyCourse({ id = 'course', title = 'Untitled course', mode = 'slides' } = {}) {
  if (mode === 'lessons') return normalize({ schema: SCHEMA_VERSION, id, title, mode });
  return normalize({ schema: SCHEMA_VERSION, id, title, scenes: [{ id: 'sc-1', title: 'Scene 1', slides: [] }] });
}

export const jsonSchema = () => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'CourseForge Studio course document v1', ...toJsonSchema(courseSchema) });

/** Deterministic-friendly id generator. `taken` is a Set of used ids. 12 hex digits: a .story save turns them into
 * the leading digits of the element's GUID, from which the importer derives the same id again. */
export function newId(prefix, taken, rng = Math.random) {
  for (;;) {
    const id = `${prefix}-${Math.floor(rng() * 2 ** 48).toString(16).padStart(12, '0')}`;
    if (!taken.has(id)) return id;
  }
}

/** All ids used in a document. */
export function allIds(doc) {
  const s = new Set([doc.id]);
  for (const x of [...doc.scenes, ...(doc.banks || []), ...doc.assets, ...doc.quizzes]) s.add(x.id);
  for (const sl of doc.slides) {
    s.add(sl.id);
    for (const o of sl.objects) s.add(o.id);
    for (const t of sl.triggers) s.add(t.id);
    for (const l of sl.layers) { s.add(l.id); for (const o of l.objects) s.add(o.id); for (const t of l.triggers) s.add(t.id); }
  }
  for (const sec of doc.sections || []) { s.add(sec.id); for (const l of sec.lessons) { s.add(l.id); for (const b of l.blocks) s.add(b.id); } }
  return s;
}

export { check, toJsonSchema };
