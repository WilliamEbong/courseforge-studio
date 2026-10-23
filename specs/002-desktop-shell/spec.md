# Spec 002: Desktop shell and installer

## Overview
CourseForge Studio installs and runs like an ordinary Windows program. The user downloads one `Setup.exe` and double-clicks it, and the app opens. There is no terminal, no Node and no zip to unblock. The existing editor and local server run inside an Electron window.

## User scenarios
1. **Install.** The user runs `CourseForge-Studio-Setup-x.y.z.exe`. It installs for the current user with no admin prompt, adds Desktop and Start menu shortcuts, and opens the app.
2. **First run.** The demo courses appear in the course list. They are copied to `Documents\CourseForge Studio` and can be opened and previewed.
3. **Open again.** Launching the app while it is already open brings the existing window to the front. A second window or a second server is never started.
4. **Something goes wrong.** For example, the courses folder can't be created. A dialog says what happened and what to do, and the details are written to `logs\main.log` in the app's data folder.
5. **Update.** When a newer release exists on GitHub, the app downloads it in the background and offers "Restart to update". The user's courses are untouched.
6. **Remove.** "Uninstall CourseForge Studio" in Windows Settings removes the program. Courses in Documents stay.

## Functional requirements
- **FR-1** The NSIS installer is one-click and per-user, needs no admin, and creates Desktop and Start menu shortcuts plus an uninstaller.
- **FR-2** `app.requestSingleInstanceLock()`: a second launch focuses and restores the first window, then exits.
- **FR-3** The server starts in-process on `127.0.0.1` with port 0 (random). The window loads that origin with the session token.
- **FR-4** Window security:
  - `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
  - navigation and new windows are allowed only to the local origin
  - `http(s)` links elsewhere open with `shell.openExternal`
- **FR-5** Errors at startup show `dialog.showErrorBox` with a plain-language message and a next step. All errors are appended to `<userData>/logs/main.log`.
- **FR-6** First run copies the samples into the courses folder only when they are missing, reusing the `cf app` first-run logic.
- **FR-7** `electron-updater` checks GitHub Releases on start. When an update has downloaded, a prompt offers "Restart to update" or "Later". Update failures are logged and never block use.
- **FR-8** `--smoke` starts the app headless, requests `/api/courses`, checks that the demo course is listed, prints `smoke ok`, and exits 0. Any failure exits 1 with the reason.
- **FR-9** The `cf` CLI and MCP server keep working from a source checkout. The unit and e2e suites run without Electron.

## Success criteria
- `npm run dist` produces `dist/*Setup*.exe` and `dist/latest.yml`.
- A silent install (`/S`) followed by the installed exe with `--smoke` exits 0.
- A Playwright `_electron` test shows the demo course listed, and a second launch keeps one window.
- The unit and e2e suites stay green.

## Defaults chosen
- Electron (latest stable) and electron-builder NSIS, following the Lumieducation/Lumi packaging approach.
- The installer is unsigned for v0.1. The user guide explains the one-time SmartScreen "More info, then Run anyway" step. Signing is on the Later list.
- No idle auto-shutdown: Qualia needs one because its server is detached from the window. Here the server lives and dies with the window.
