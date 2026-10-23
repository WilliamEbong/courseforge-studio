# CourseForge Studio: agent instructions (Codex)

Spec Kit project: plan and build features with the speckit-* skills (constitution once; then specify → plan → tasks → implement → converge). Do not use superpowers brainstorming, writing-plans, executing-plans, or subagent-driven-development here; superpowers debugging, TDD, and verification skills are still fine.

## Project rules
- **One command layer.** Every feature that changes a course is a registry command in `packages/core` (`{name, summary, args, examples, run}`). The editor, CLI, HTTP API, MCP server and the AI assistant are thin front-ends over it.
- **Plain JavaScript ES modules, no build step** for the app packages. Runtime dependencies are limited to Electron and its updater (desktop shell only).
- **Public repository.** `tests/unit/clean-room.test.js` must stay green: only original code and assets, no private paths, secrets or internal working notes in files or commit messages.
- **AI never edits a course directly.** It works on a draft; the user applies the change, which is one undo step.
- Tests: `npm test` (node:test) and `npm run e2e` (Playwright). AI tests use the fake provider; live calls only with `CF_AI_LIVE=1`.
