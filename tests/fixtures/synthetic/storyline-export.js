import { emptyCourse, normalize } from '../../../packages/schema/index.js';

// Original small course for all export surfaces and the lead's import smoke check.
export function exportCourse() {
  return normalize({ ...emptyCourse({ id: 'storyline-export', title: 'Storyline export smoke check' }), size: { w: 960, h: 540 },
    scenes: [{ id: 'scene', title: 'Export demo', slides: ['start', 'question', 'finish'] }],
    slides: [
      { id: 'start', title: 'Editable visual slide', notes: 'Original synthetic speaker notes.', objects: [
        { id: 'welcome', type: 'text', text: 'Original editable text', x: 40, y: 80, w: 500, h: 60 },
        { id: 'circle', type: 'shape', shape: 'ellipse', text: 'Shape', x: 40, y: 170, w: 150, h: 100, style: { fill: '#CDE8E2', color: '#102020' } },
        { id: 'open', type: 'button', text: 'Open details', x: 40, y: 320, w: 220, h: 60, alt: 'Open the detail layer' },
      ], layers: [{ id: 'details', modal: true, objects: [
        { id: 'detail', type: 'text', text: 'Layer preserved in the Web Object', x: 40, y: 100, w: 700, h: 80 },
        { id: 'proceed', type: 'button', text: 'Go to question', x: 40, y: 260, w: 240, h: 60 },
      ], triggers: [{ id: 'go', on: { event: 'click', target: 'proceed' }, do: [{ action: 'jump', to: 'question' }] }] }],
      triggers: [{ id: 'show', on: { event: 'click', target: 'open' }, do: [{ action: 'showLayer', layer: 'details' }] }] },
      { id: 'question', title: 'Question import', question: { type: 'mc', prompt: 'Which shape was shown?', points: 10, choices: [
        { id: 'ellipse', label: 'Ellipse', correct: true }, { id: 'rectangle', label: 'Rectangle' },
      ] } },
      { id: 'finish', title: 'Finished', objects: [{ id: 'done', type: 'text', text: 'Course finished', x: 40, y: 100, w: 500, h: 80 }],
        triggers: [{ id: 'complete', on: { event: 'timelineStart' }, do: [{ action: 'completeCourse' }] }] },
    ],
  });
}
