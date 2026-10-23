# ADR 0001: Stack: zero-dependency web app plus a local Node server

Status: accepted (2026-10-16). Revisit if the editor UI becomes unmanageable without a framework.

## Context
- The user wants local-first: no cloud and no hosted server.
- A small dependency tree keeps installs fast and the attack surface small.
- Published courses must run offline with no external requests, so the learner runtime cannot depend on a CDN or a framework.
- Node 24 is available. Its stdlib has `node:test`, `node:http`, `zlib.crc32` and `zlib.deflateRawSync`.

## Decision
- **Language:** plain JavaScript ES modules, no build step. Shared data shapes are documented in `packages/schema` and enforced by a runtime validator, not a type checker.
- **Runtime (`packages/runtime`)**: one dependency-free module. It is the deterministic state machine for slides, layers, states, triggers, variables and quiz. The editor preview and every published package use the same file.
- **Editor (`packages/editor`)**: vanilla DOM. The UI is a pure render of the editor state; mutations go through one command function, which gives undo/redo for free.
- **Server (`server.js`)**: `node:http` bound to 127.0.0.1. It serves the editor and runs save/open/publish against a local `courses/` folder. Paths are confined to that folder.
- **Publisher (`packages/publisher`)**: writes a self-contained folder. It also writes a ZIP using a small stdlib writer (stored/deflate entries, CRC via `zlib.crc32`). Output targets are static web and SCORM 1.2.
- **Tests:** `node:test` for schema, runtime and publisher. `@playwright/test` (the only dev dependency) for editor and learner end-to-end tests.

## Consequences
- There is no type checker. Schema validation at load and save is the safety net, and it gets thorough unit tests.
- Packaging as a desktop app (Electron/Tauri) is deferred until it is needed. `npm start` plus a browser tab covers "local app".
