# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A recovered reconstruction of a final-year "VFU E-Learning Classroom" project (role dashboards, virtual classroom, attendance, assignments, discussions, analytics). It was rebuilt from a report document after the original workspace was lost, so it favors a working, dependency-light app over byte-for-byte fidelity to any prior implementation.

## Commands

```powershell
npm start        # node server.js — serves API + static frontend on http://localhost:3000
npm test         # node --test tests/server.test.js
```

There is no build step, bundler, transpiler, or lint config in this repo — `public/` is served as-is and `server.js` runs directly under Node's built-in `http` module.

Note: `node --test tests/` (passing the bare directory) fails to resolve on Node 24/Windows in this environment — invoke the test file directly or with a glob (`node --test tests/**/*.test.js`), which is what the `test` script does.

## Environment note: port 3000 conflicts

`npm start` binds port 3000 by default. On a machine already running something else on that port (e.g. another dev server), it'll fail with `EADDRINUSE`. Override with `PORT=3055 npm start` (or `$env:PORT=3055; npm start` in PowerShell) if that happens — this is a local-machine conflict, not a bug in the app.

## Architecture

### Two runtimes, one API surface

The frontend (`public/app.js`) is written to talk to a JSON API (`/api/state`, `/api/login`, `/api/signup`, `/api/attendance`, `/api/submissions`, `/api/discussions/reply`, `/api/courses`) and works identically in two modes:

- **Served mode** — opened via `http://localhost:3000` (through `npm start`). Requests hit the real Node server in `server.js`.
- **Offline mode** — `public/index.html` opened directly as a `file://` URL. An IIFE at the top of `public/app.js` detects `window.location.protocol === "file:"` and monkey-patches `window.fetch` to intercept any `/api/*` call, reading/writing state from `localStorage` (seeded from `window.VFU_SEED_STATE` in `public/state.js`) instead of hitting a server.

**Consequence for changes:** any new or modified `/api/*` route in `server.js` must have a matching branch added to the `window.fetch` override in `public/app.js`, or offline mode silently diverges from served mode (or 404s via the offline shim's own not-found fallback).

### server.js request handling

- `createServer()` builds a single `http.createServer` handler that routes anything under `/api/` to `handleApi`, everything else to `serveStatic` (which resolves files under `public/`, falls back to `index.html` for unknown paths — SPA-style routing — and guards against path traversal via `publicFilePath`).
- `handleApi` reads the whole JSON dataset (`readData()`), parses the request body (`readBody()`, buffered and JSON-parsed, capped at ~1MB), dispatches by method+path, and lets individual handlers mutate the in-memory `data` object and persist it via `writeData()`.
- Persistence is a flat JSON file (`data/vfu-data.json`), not a database for app data. Writes are atomic (write to `.tmp`, then `fs.renameSync`). `readData()` falls back to a `.bak` file, then to `defaultData`, if the JSON is missing/corrupt. `ensureDataShape()` normalizes/backfills any missing top-level collections so partially-written or legacy data files don't crash handlers.

### Auth: JSON-first (zero-cost deploy target), optional MySQL

The default/production deploy path uses the JSON data file for both user storage and auth — no database required. MySQL is opt-in only: `getDbPool()` returns `null` immediately unless `DB_HOST` is set in the environment (see `.env.example`). When enabled, it connects to MySQL (`dbConfig`, all fields from `DB_*` env vars), auto-creates/migrates the `users` table (`ensureUsersTableSchema`), and seeds the three demo accounts.

Passwords are hashed with salted `crypto.scryptSync` (`hashPassword`/`verifyPassword`, format `scrypt$<salt>$<hash>`), not raw SHA-256. Both `handleLogin` and `handleSignup` try the MySQL path first when a pool is available (returning 401 immediately on a mismatch — no falling through to the JSON store on wrong credentials), and use the JSON `users` array otherwise. Any change to auth behavior generally needs to be made in *both* code paths to stay consistent.

Sessions are real: `issueSession()` writes a random token into `data.sessions` (persisted in the JSON file, TTL via `SESSION_TTL_HOURS`) and `authenticate(req, data)` validates the `Authorization: Bearer <token>` header on every mutating route (`/api/attendance`, `/api/submissions`, `/api/discussions/reply`, `/api/courses`) plus role checks (e.g. only lecturer/admin can create courses) and identity checks (a user can only submit/post/mark attendance as themselves). `GET /api/state` stays public but is passed through `publicState()`, which strips `passwordHash` from users and omits `sessions` entirely — never add a field to that response without checking it isn't a secret. `public/app.js`'s `api()` helper attaches the bearer token from `localStorage`'s `vfu-session` automatically; new fetch calls should go through `api()` rather than raw `fetch()` so they stay authenticated.

`handleApi` also rate-limits `/api/login` and `/api/signup` per IP (`isRateLimited`, in-memory, resets on restart) and `createServer()` applies baseline security headers (CSP, X-Frame-Options, etc.) via `applySecurityHeaders()` to every response.

### Frontend: single file, no framework

`public/app.js` is a hand-rolled SPA: a `state` object (loaded from `/api/state`) plus a handful of module-level variables (`currentRoute`, `currentUser`, `liveRoom`, etc.) drive `render()`, which re-renders the entire `#viewRoot` innerHTML from a `viewMap` keyed by route (`dashboard`, `courses`, `classroom`, `attendance`, `assignments`, `discussions`, `analytics`, `admin`). There's no virtual DOM/diffing — every state change calls `render()` and replaces the relevant HTML wholesale.

All interactivity is delegated through two document-level listeners registered once in `registerAppEvents()`: a `click` handler (`handleViewInteraction`) that dispatches on `data-*` attributes (`data-route`, `data-route-jump`, `data-live-action`, `data-quiz-vote`, etc.), and a `submit` handler that dispatches on form `id` (`authForm`, `courseForm`, `chatForm`, `quizForm`). New interactive elements should follow this `data-*` attribute + central dispatch pattern rather than attaching one-off listeners.

Session identity persists across reloads via `localStorage` (`vfu-session`), separately from the offline app-state blob (`vfu-offline-state`).

### Data model

`data/vfu-data.json` and `public/state.js`'s `VFU_SEED_STATE` share the same shape (kept in sync by hand — there's no shared schema file): `institution`, `users`, `courses`, `classSessions`, `attendance`, `assignments`, `submissions`, `discussions` (each with a `replies` array), `notifications`, `analytics`. `server.js`'s `defaultData`/`ensureDataShape` is the authoritative shape reference when adding a new field.
