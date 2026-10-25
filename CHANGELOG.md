# Changelog

## Unreleased
- **Text inputs can report their answer to the LMS.** Turn on **Report the answer to the LMS (ungraded)** (`report: true`) and SCORM 1.2 receives the text as a `fill-in` interaction with result `neutral` when the learner leaves the slide (or exits); text typed before the window closed is sent after the learner resumes. It never changes the score or mastery, and the learner sees no feedback. The response is cut to SCORM's 255 characters; the full text still resumes.
- **Text inputs have a character limit.** **Most characters** (`maxLength`, 1 to 1,000) defaults to 400, is enforced as the learner types, and shows as a count while the input has focus.
- **Resume-size warning.** **Check** (the new `resume` query) and SCORM publishing warn when the course's resume data could pass SCORM 1.2's 4,096 characters with every text input full.

## 0.1.1
- **Every AI-built question now teaches through its feedback.** After building a course, CourseForge Studio checks each question. If any still has the generic "Correct!" / "Not quite." text, Claude writes explanatory feedback for it in one extra step.
- **The review and the change card now see question feedback,** so the review no longer reports feedback as missing when it is there, and edits to feedback show in the diff.

## 0.1.0
- First release: slide and lessons authoring, Web and SCORM 1.2 publishing, .story files, and Claude built in (Create with AI, Ask Claude, Review course).
