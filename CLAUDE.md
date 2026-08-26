# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A recovered reconstruction of a final-year "VFU E-Learning Classroom" project (role dashboards, virtual classroom, attendance, assignments, discussions, analytics). It was rebuilt from a report document after the original workspace was lost, so it favors a working, dependency-light app over byte-for-byte fidelity to any prior implementation.

## Commands

```powershell
npm start        # node server.js — serves API + static frontend on http://localhost:3000
npm test         # node --test tests/server.test.js tests/offline-shim.test.js
```

There is no build step, bundler, transpiler, or lint config in this repo — `public/` is served as-is and `server.js` runs directly under Node's built-in `http` module.

Note: `node --test tests/` (passing the bare directory) fails to resolve on Node 24/Windows in this environment — invoke the test file directly or with a glob (`node --test tests/**/*.test.js`), which is what the `test` script does.

## Environment note: port 3000 conflicts

`npm start` binds port 3000 by default. On a machine already running something else on that port (e.g. another dev server), it'll fail with `EADDRINUSE`. Override with `PORT=3055 npm start` (or `$env:PORT=3055; npm start` in PowerShell) if that happens — this is a local-machine conflict, not a bug in the app.

## Architecture

### Two runtimes, one API surface

The frontend (`public/app.js`) is written to talk to a JSON API (`/api/state`, `/api/login`, `/api/signup`, `/api/attendance`, `/api/submissions`, `/api/discussions/reply`, `/api/courses`) and works identically in two modes:

- **Served mode** — opened via `http://localhost:3000` (through `npm start`). Requests hit the real Node server in `server.js`.
- **Offline mode** — `public/index.html` opened as a `file://` URL, or hosted statically (e.g. the Vercel config here) where nothing answers `/api/*`. An IIFE at the top of `public/app.js` monkey-patches `window.fetch` to intercept any `/api/*` call, reading/writing state from `localStorage` (seeded from `window.VFU_SEED_STATE` in `public/state.js`) instead of hitting a server.

**The offline shim is an auth boundary, not a bypass.** It verifies a salted SHA-256 password hash (`sha256$<salt>$<hex>`, hand-rolled in the IIFE because `crypto.subtle` does not exist on `file://` — a non-secure context), issues and stores session tokens in `data.sessions`, resolves the caller from the `Authorization: Bearer` header via `sessionUser()`, mirrors `server.js`'s `requireRole` table in `ROLE_RULES`, and overwrites `body.actingUserId` with the token's user so a caller can never claim to be someone else. `public/state.js`'s seed users carry `passwordHash` values in that format; `backfillOfflinePrograms()` restores them onto `localStorage` blobs written before this existed.

**Consequence for changes:** any new or modified `/api/*` route in `server.js` must have a matching branch added to the `window.fetch` override in `public/app.js` — including its auth and role checks — or offline mode silently diverges from served mode (or 404s via the offline shim's own not-found fallback). `tests/offline-shim.test.js` runs that IIFE in a VM and is the place to assert the offline half.

### server.js request handling

- `createServer()` builds a single `http.createServer` handler that routes anything under `/api/` to `handleApi`, everything else to `serveStatic` (which resolves files under `public/`, falls back to `index.html` for unknown paths — SPA-style routing — and guards against path traversal via `publicFilePath`).
- `handleApi` reads the whole JSON dataset (`readData()`), parses the request body (`readBody()`, buffered and JSON-parsed, capped at ~1MB), dispatches by method+path, and lets individual handlers mutate the in-memory `data` object and persist it via `writeData()`.
- Persistence is a flat JSON file, not a database for app data. It lives at `DATA_DIR/vfu-data.json`, where `DATA_DIR` defaults to the repo's `data/` folder but can point at a mounted persistent disk (see `render.yaml`). When that directory is empty on first boot, `readData()` seeds it by copying the dataset bundled with the build (`SEED_FILE`) rather than falling back to the near-empty `defaultData`, so a fresh disk does not start an institution with no courses. Writes are atomic (write to `.tmp`, then `fs.renameSync`). `readData()` falls back to a `.bak` file, then to `defaultData`, if the JSON is missing/corrupt. `ensureDataShape()` normalizes/backfills any missing top-level collections so partially-written or legacy data files don't crash handlers.

### Auth: JSON-first (zero-cost deploy target), optional MySQL

The default/production deploy path uses the JSON data file for both user storage and auth — no database required. MySQL is opt-in only: `getDbPool()` returns `null` immediately unless `DB_HOST` is set in the environment (see `.env.example`). When enabled, it connects to MySQL (`dbConfig`, all fields from `DB_*` env vars), auto-creates/migrates the `users` table (`ensureUsersTableSchema`), and seeds the three demo accounts.

Passwords are hashed with salted `crypto.scryptSync` (`hashPassword`/`verifyPassword`, format `scrypt$<salt>$<hash>`), not raw SHA-256. Both `handleLogin` and `handleSignup` try the MySQL path first when a pool is available (returning 401 immediately on a mismatch — no falling through to the JSON store on wrong credentials), and use the JSON `users` array otherwise. Any change to auth behavior generally needs to be made in *both* code paths to stay consistent.

Sessions are real: `issueSession()` writes a random token into `data.sessions` (persisted in the JSON file, TTL via `SESSION_TTL_HOURS`) and `authenticate(req, data)` validates the `Authorization: Bearer <token>` header on every mutating route (`/api/attendance`, `/api/submissions`, `/api/discussions/reply`, `/api/courses`) plus role checks (e.g. only lecturer/admin can create courses) and identity checks (a user can only submit/post/mark attendance as themselves). `GET /api/state` answers without a token but tells the caller apart: `publicState(data, auth)` returns only `institution` and `programs` (every collection empty, `authenticated: false`) to a signed-out caller, so the user directory and course data cannot be read or enumerated before sign-in, and the full dataset — minus `passwordHash` and `sessions`, with `authenticated: true` — to a valid session. Never add a field to that response without checking it isn't a secret. The client trusts that flag over its own storage: `loadState()` clears `localStorage`'s `vfu-session` and returns to the login screen whenever the server reports `authenticated: false`, so a hand-edited or expired session cannot produce a signed-in UI.

Public signup (`handleSignup`) is student-only and refuses to create an *unassigned* account: a valid `programId` and a student number are required, and the role is forced regardless of what the caller sends. Lecturer and admin accounts exist only via `POST /api/admin/users` (admin-only), and `PATCH /api/users/:id` remains the sole way to change a role afterwards.

The per-IP login limiter counts **failed** attempts only (`isRateLimited` peeks, `recordAttempt` charges the bucket, and `handleLogin` returns a boolean for that purpose), so a shared campus IP is not locked out by successful sign-ins. Signup still counts every attempt.

`public/app.js`'s `api()` helper attaches the bearer token from `localStorage`'s `vfu-session` automatically; new fetch calls should go through `api()` rather than raw `fetch()` so they stay authenticated.

`handleApi` also rate-limits `/api/login` and `/api/signup` per IP (`isRateLimited`, in-memory, resets on restart) and `createServer()` applies baseline security headers (CSP, X-Frame-Options, etc.) via `applySecurityHeaders()` to every response.

### Frontend shell: desktop sidebar, mobile drawer + tab bar

`public/index.html` holds one shell for both form factors. Above 900px it is the classic sidebar + top bar. At 900px and below, CSS turns `.sidebar` into a fixed off-canvas drawer (opened by `body.drawer-open`, backed by `#drawerScrim`) and switches on `#tabBar`, a fixed bottom tab bar rendered by `renderTabBar()` from `MOBILE_TABS` plus a "More" button that opens the drawer. `setDrawer()` is the only thing that toggles drawer state; `setRoute()` closes it. The same `[data-sidebar-toggle]` button collapses the sidebar on desktop and opens the drawer on phones (`isMobileLayout()`). The theme picker is duplicated into the drawer on mobile and both copies stay in sync through `syncThemeDots()`.

Two layout rules matter when adding views: grid containers use `minmax(0, 1fr)` rather than a bare `1fr`/implicit `auto` (an auto track is sized to its widest child's max-content — a `<select>` is as wide as its longest option — which is what made the page scroll sideways on phones), and wide content (tables) belongs in `.table-scroll`. Mobile also enforces 44px minimum touch targets and 16px form fonts (to stop iOS zoom-on-focus).

`public/manifest.webmanifest`, `public/icon.svg` and `public/sw.js` make the app installable (Add to Home Screen, and the basis for a TWA/Play Store wrapper). The service worker is network-first and never caches `/api/*`.

### Frontend: single file, no framework

`public/app.js` is a hand-rolled SPA: a `state` object (loaded from `/api/state`) plus a handful of module-level variables (`currentRoute`, `currentUser`, `liveRoom`, etc.) drive `render()`, which re-renders the entire `#viewRoot` innerHTML from a `viewMap` keyed by route (`dashboard`, `courses`, `classroom`, `attendance`, `assignments`, `discussions`, `analytics`, `admin`). There's no virtual DOM/diffing — every state change calls `render()` and replaces the relevant HTML wholesale.

All interactivity is delegated through two document-level listeners registered once in `registerAppEvents()`: a `click` handler (`handleViewInteraction`) that dispatches on `data-*` attributes (`data-route`, `data-route-jump`, `data-live-action`, `data-quiz-vote`, etc.), and a `submit` handler that dispatches on form `id` (`authForm`, `courseForm`, `chatForm`, `quizForm`). New interactive elements should follow this `data-*` attribute + central dispatch pattern rather than attaching one-off listeners.

Session identity persists across reloads via `localStorage` (`vfu-session`), separately from the offline app-state blob (`vfu-offline-state`).

### Data model

`data/vfu-data.json` and `public/state.js`'s `VFU_SEED_STATE` share the same shape (kept in sync by hand — there's no shared schema file): `institution`, `users`, `courses`, `classSessions`, `attendance`, `assignments`, `submissions`, `discussions` (each with a `replies` array), `notifications`, `analytics`. `server.js`'s `defaultData`/`ensureDataShape` is the authoritative shape reference when adding a new field.
