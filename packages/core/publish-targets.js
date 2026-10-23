// Shared I/O target registry; adapters only choose paths and call the named publisher.
export const PUBLISH_TARGETS = Object.freeze({
  web: { method: 'publishWeb', extension: '' },
  scorm12: { method: 'publishScorm12', extension: '' },
  pptx: { method: 'publishPptx', extension: '.pptx' },
  questions: { method: 'publishQuestions', extension: '.xlsx' },
});
