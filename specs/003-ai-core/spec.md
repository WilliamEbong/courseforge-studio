# Spec 003: AI core (Claude CLI provider, drafts, limits)

## Overview
Claude can change a course on the author's request. AI runs through the author's own signed-in Claude Code CLI (their subscription), so the app holds no API key. Claude works on a draft. The author sees what changed and applies or discards it.

## Functional requirements
- **FR-1 Provider.** The app runs `claude -p` in stream-json mode with the prompt on stdin and the system prompt in a file. It always passes `--model` and isolates the run from the user's own setup:
  - `--safe-mode`
  - `--strict-mcp-config`
  - `--tools ""`
  - `--permission-mode dontAsk` with an allow list
  - `--no-session-persistence`

  On Windows the npm `.cmd` shim is resolved to the real `claude.exe`, so no shell is used.
- **FR-2 Errors.** Not installed, not signed in, busy or at its usage limit, timeout, turn limit and crash each produce a plain message and a next step.
- **FR-3 Draft.** Each request copies the course to `.ai-draft-<id>` beside it, so asset paths still resolve. The course MCP server is started with `--only <draft>`, so Claude can read the draft and run commands on it and touch nothing else. Publish, import, new_course and undo/redo are not allowed.
- **FR-4 Change card.** The card holds Claude's summary, the commands it ran, and a line diff of the course outline before and after. A request that changes nothing leaves no draft.
- **FR-5 Apply.** Apply writes the draft into the course with `course.replace` as one history entry labelled "AI: <summary>". If the course changed after the draft was taken, Apply is refused (409) and the draft is dropped. Discard deletes the draft.
- **FR-6 Limits.**
  - AI is off until enabled.
  - Every request is capped at 12 tool turns and 5 minutes.
  - A daily request budget (default 100) refuses requests before anything runs.
  - Requests, failures and the API-equivalent cost are recorded per day in `<data>/ai.json`.
- **FR-7 HTTP.**
  - `GET/POST /api/ai`: status and settings.
  - `POST /api/courses/:name/ai/ask`: NDJSON progress, then `done` with the card or `error`.
  - `/ai/apply` and `/ai/discard`.
- **FR-8 Tests.** `fakeProvider` replays scripted command batches, and `CF_AI_FAKE=<script.json>` turns it on for the server. `tests/fixtures/ai/fake-claude.mjs` imitates the CLI for provider tests.

## Success criteria
- `tests/unit/ai.test.js`, `tests/unit/server-ai.test.js` and the MCP `--only` test pass.
- The full unit suite stays green.
