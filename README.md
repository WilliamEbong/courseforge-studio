# CourseForge Studio

**Build interactive e-learning courses on your own computer, with Claude as your co-author.**

CourseForge Studio is a free, open-source desktop app for Windows. You build slide courses (states, layers, triggers, variables, quizzes) or scrolling lessons courses, then publish them to offline Web or SCORM 1.2 for any LMS. Claude, through your own Claude account, can draft a course from a brief or your documents, review it, and fix what it finds. You see every change before it is applied.

![The start screen](docs/images/courses.png)

## What it does

- **Slide courses:** scenes, slides, text, shapes, buttons, images, video and audio with captions, hotspots, sliders, dials, markers. Objects have states, layers and triggers with conditions, plus variables, a timeline and animations.
- **Quizzes:** eight question types, question banks and random draws, results slides with Retry and Review, and LMS reporting.
- **Lessons courses:** 21 block types (accordion, tabs, flashcards, process, scenario and more) that read well on phones.
- **Themes, an original image library, an accessibility check and live Preview.**
- **Publish:** Web (works offline from `index.html`) and SCORM 1.2, plus PowerPoint and question-file export. Opens and saves `.story` files.
- **Claude built in:**
  - **Create with AI** turns a brief and optional Word, PDF, Markdown or text files into an outline you edit, then builds the course.
  - **Ask Claude** changes the open course from a plain-language request.
  - **Review course** lists what to fix, and each finding can be fixed with one click.

  Every AI change arrives as a change card that you apply or discard. An applied change is one Undo step.
- **For agents and scripts:** the same command registry is available from the `cf` command line, a local HTTP API and an MCP server.

![Claude's change card](docs/images/assistant.png)

## Install

1. Download `CourseForge-Studio-Setup-<version>.exe` from [Releases](https://github.com/WilliamEbong/courseforge-studio/releases/latest).
2. Double-click it. It installs for your Windows account: there is no administrator prompt and nothing else to install. It adds Desktop and Start menu shortcuts and opens the app with two sample courses.
3. The installer is not code-signed yet. If SmartScreen appears, choose **More info**, then **Run anyway**.

Updates download in the background and ask before restarting. To remove the app, go to **Settings > Apps > Installed apps > CourseForge Studio > Uninstall**. Your courses stay in `Documents\CourseForge Studio`.

## Turn on Claude (optional)

1. Install [Claude Code](https://claude.com/claude-code). Open a terminal, run `claude`, and sign in with `/login`.
2. In CourseForge Studio, click **Set up Claude** and turn AI on.

AI is off until you turn it on. CourseForge Studio stores no API key: it uses Claude Code on your computer with your own plan.

- **What is sent:** only your request, the open course and any document you attach.
- **How changes land:** Claude edits a copy, and nothing changes until you choose Apply.
- **Limits:** a daily request limit (100 by default) and per-request step limits keep usage predictable.

The [user guide](docs/user-guide.md) covers everything step by step.

## Develop

Requires Node.js 24 and Google Chrome (for the browser tests).

```bash
npm ci
npm test
npm run e2e
npm start
npm run dist
```

`npm test` runs the unit tests and `npm run e2e` the browser tests. `npm start` runs the desktop app from source, and `npm run dist` builds the Windows installer into `dist/`.

AI tests use a scripted provider and never call Claude. The packages are plain JavaScript ES modules with no build step:

| Package | What it is |
|---|---|
| `schema`, `core` | Course format, validation, and the command registry every front end uses |
| `runtime`, `player` | Learner runtime and players (slides and lessons) |
| `editor` | The authoring UI |
| `server`, `desktop` | Local HTTP server, and the Electron shell |
| `ai` | Claude Code CLI provider, assistant drafts, create-with-AI and review |
| `publisher`, `import-story`, `export-story` | Web, SCORM, PPTX, question files and `.story` |
| `cli`, `mcp`, `lms-test-harness` | Command line, MCP server, and a local SCORM 1.2 test LMS |

See [docs/agent-guide.md](docs/agent-guide.md) to drive the app from your own agents.

## Licence

MIT. Storyline 360, PowerPoint and Excel are trademarks of their owners and are named only to describe file compatibility. CourseForge Studio is not affiliated with them.
