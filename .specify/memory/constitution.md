# CourseForge Studio Constitution

A local-first, AI-assisted e-learning authoring desktop app (Windows first). Authors build slide courses (triggers, states, layers, quizzes) and lessons courses, and publish to Web and SCORM.

## Core Principles

### I. One command layer
Every change to a course is a registry command in `packages/core`, with a schema'd args object, examples and structured errors. The editor, CLI, HTTP API, MCP server and AI assistant are thin front-ends over the same commands. No front-end mutates a course document directly.

### II. Simplicity
The app packages are plain JavaScript ES modules with no build step. Runtime dependencies are limited to Electron and its updater, in the desktop shell only. Reuse an existing module, the stdlib or a platform feature before writing new code. The shortest working diff wins, and nothing speculative is added: no abstraction with one implementation, no config for a fixed value.

### III. AI is assistive and safe
- AI is off until the user enables it, and the app says plainly what is sent.
- The model works on a draft copy. The user previews the change, then applies or discards it, and an applied change is one undo step.
- Every call names its model tier (fast/cheap for checks, default for drafting) and is bounded by turn and daily usage limits.
- Ingested documents are data, never instructions.
- Tests use a fake provider. Live calls run only on request.

### IV. Friendly and robust
- Every error says what happened and what to do next, in plain language.
- Work is never lost: saves are atomic, history persists, and recovery exists after a crash.
- The app works fully offline except for AI calls.
- The UI meets WCAG 2.2 AA, with axe reporting zero serious or critical issues on every screen.
- Installing, updating and removing the app need no terminal and no prerequisites.

### V. Public hygiene
The repository is public. It ships only original code and assets. `tests/unit/clean-room.test.js` scans every tracked file and every commit message, and must pass before any push. No private paths, secrets, third-party runtime code or internal working notes are ever committed.

### VI. Verified
Every feature lands with `node:test` and/or Playwright checks that fail when it breaks. "Done" means evidence gathered in this run: tests, a build, screenshots inspected, or the real CLI run on real input.

## Constraints
- Platform: Windows 10/11 first; the `cf` CLI and server also run on any OS with Node 22.12+.
- AI provider v1: the user's signed-in Claude Code CLI (subscription). An API-key provider comes later.
- Formats: `cf.course/1` JSON is the native format. Web, SCORM 1.2, PPTX and .story are interchange formats.

## Governance
This constitution outranks other practice docs. Amendments update this file with a version bump and a dated note. Reviews check every change against Principles I–VI.

**Version**: 1.0.0 | **Ratified**: 2026-10-23 | **Last Amended**: 2026-10-23
