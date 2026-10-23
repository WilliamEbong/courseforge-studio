# Spec 006: Create a course with AI, and course review

## Overview
From the start screen, the author describes a course and can attach Word, PDF, Markdown or text documents. Claude drafts an outline, which the author edits. Then Claude builds the course one scene or section at a time. The course appears only when it is complete. A review lists what to fix, and each finding has a "Fix with Claude" button.

This flow keeps the useful part of the CourseForge pipeline (brief, then design, then build, then review) and drops its cost drivers: there is no reviewer panel, no adjudication and no repair loops, and the item count is capped by course length.

## Functional requirements
- **FR-1 Brief.** The author gives a topic, audience, length (5–60 min) and type (slides or lessons), and can attach documents. Attachments are copied into `imports/` in the courses folder. Text is extracted from Markdown, text and Word files with the stdlib zip reader. Claude reads PDFs itself, with the Read tool limited to that folder.
- **FR-2 Outline.** Claude returns `{title, outline}` as structured output, in the `outline.add` text format.
  - The outline must parse and have at most `clamp(round(minutes/3), 3, 40)` items.
  - If it fails either check, Claude gets one retry with the reason.
  - The author can edit the title, file name and outline text, and a live item count shows as they edit.
- **FR-3 Build.**
  - A hidden draft `.ai-draft-new-<name>.course.json` is created from the outline.
  - Claude then gets one session per scene or section, on the draft, through the MCP server locked with `--only`.
  - Progress is saved after each part to `<data>/builds/<name>.json`. After a failure, "Continue building" resumes from the next part.
  - When every part is done, the draft is renamed to `<name>.course.json`, and validate plus a11y issues are counted.
- **FR-4 Review.** The fast model reads the full-text outline and the a11y results and returns at most 10 findings `{title, detail, fix, severity}`. "Fix with Claude" sends `fix` to the assistant, which produces a normal change card.
- **FR-5 Limits and errors.** Every Claude call goes through the same settings check (AI on, daily limit), is counted, and has a turn limit (6 for the outline, 14 per build part, 3 for the review). Errors show in the dialog with a next step.

## Success criteria
- `tests/unit/ai-create.test.js` covers the item limit, document text, the outline retry, attachment path escape, a resumable build that publishes only when complete, and the review.
- `tests/e2e/ai-create.spec.js` runs the whole flow through the UI with a Word file, then publishes SCORM 1.2.
