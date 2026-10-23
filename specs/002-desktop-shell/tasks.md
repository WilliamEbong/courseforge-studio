# Tasks 002: Desktop shell and installer

Plan: Electron 45 (bundled Node 24.22) main process at `packages/desktop/main.js`. It calls the existing `createServer` from `packages/server/server.js` in-process on port 0. The first-run logic is moved out of `cf app` into `packages/server/projects.js` so both entry points share it. electron-builder NSIS is configured in `electron-builder.yml`, and electron-updater checks GitHub Releases.

- [x] T1 Move first-run setup into `packages/server/projects.js`, used by `cf app` and the desktop shell (FR-6)
- [x] T2 `packages/desktop/main.js`: single-instance lock, in-process server, secure window, external links, error dialog plus log, `--smoke` (FR-2 to FR-5, FR-8)
- [x] T3 Updater: `checkForUpdates` when packaged; "Restart to update" or "Later" dialog; failures logged only (FR-7)
- [x] T4 `electron-builder.yml`: one-click per-user NSIS, shortcuts, GitHub publish; `npm run dist` (FR-1)
- [x] T5 `tests/e2e/desktop.spec.js`: first-run list, secure webPreferences, a second launch keeps one window
- [x] T6 CI: build the installer, install silently, smoke-test the installed exe

## Evidence (2026-10-23)
- `npx electron . --smoke`: `smoke ok node 24.22.0 electron 45.0.0`
- desktop e2e: 1 passed
- `npm run dist`: `CourseForge-Studio-Setup-0.1.0.exe` (113 MB) and `latest.yml`
- `Setup.exe /S` exits 0; the Desktop shortcut (in the redirected Desktop folder) and the Start menu shortcut exist; the installed exe with `--smoke` exits 0
