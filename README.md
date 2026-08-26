# VFU E-Learning Classroom

Recovered local build of the VFU E-Learning Classroom final year project.

The original workspace was empty, so this rebuild was reconstructed from `VFU_Elearning_60_Page_Report.docx`. The report described a platform with virtual classrooms, attendance tracking, course management, assignments, forums, notifications, analytics, and role-based dashboards for students, lecturers, and administrators.

## Run

Open `public/index.html` directly in a browser for offline mode. The app will use `public/state.js` and browser `localStorage` for demo persistence.

After Node.js is installed, you can run the API-backed version:

```powershell
npm start
```

Then open:

```text
http://localhost:3000
```

## On a phone

The layout is responsive down to ~320px: below 900px the sidebar becomes a slide-in drawer and primary navigation moves to a bottom tab bar (Home, My Courses, Live Room, Messages, More), with 44px touch targets throughout.

It is also installable. Open the deployed URL in Chrome or Safari on the phone and choose "Add to Home Screen" — it launches full screen with its own icon. For a Play Store listing, wrap the same URL as a Trusted Web Activity (e.g. with Bubblewrap) rather than rebuilding the app natively; `public/manifest.webmanifest` already provides the name, icon, colours and shortcuts a TWA needs.

## Demo Roles

- Student: `student@vfu.local` / `student123`
- Lecturer: `lecturer@vfu.local` / `lecturer123`
- Admin: `admin@vfu.local` / `admin123`

Sign-in is enforced in **both** runtimes (the Node server and the offline/static fallback):

- Only a registered account can sign in. An unknown email is rejected, and so is a real account used under the wrong role — picking "Admin" on the login form does not grant an admin session.
- Self-registration creates a **student**, always, whatever role the request asks for, and only with a real program and student number. Lecturer and admin accounts are provisioned by an existing admin.
- Signed-out visitors get no data at all from the API beyond the institution name and program list — no user directory to enumerate.
- A tampered or expired session in browser storage drops straight back to the login screen.

## Deploying (zero-cost)

The app needs no database — it runs entirely on the JSON file store unless you explicitly opt into MySQL. To deploy for free:

1. Push this repo to GitHub.
2. Create a free web service on [Render](https://render.com), [Railway](https://railway.app), or [Fly.io](https://fly.io), pointing at the repo.
3. Build command: `npm install`. Start command: `npm start`. The host sets `PORT` automatically.
4. Leave `DB_HOST` unset — auth and all data persist to `data/vfu-data.json` on the host's disk.

Copy `.env.example` to `.env` for local overrides (session TTL, optional MySQL). Free tiers may sleep on inactivity and use ephemeral disks (data can reset on redeploy) — fine for a demo/coursework deployment, not for storing real student data long-term.

## What Is Included

- Dependency-free Node HTTP server in `server.js`
- Static frontend in `public/`
- Browser offline seed in `public/state.js`
- JSON seed database in `data/vfu-data.json`
- Working modules for dashboard, courses, virtual classroom, attendance, assignments, discussions, analytics, notifications, and administration
- Persistent local mutations for attendance, assignment submissions, discussion replies, and course creation

## Recovery Notes

This is a practical reconstruction, not a byte-for-byte restore of the lost laptop source. It intentionally avoids external packages so the app can run immediately on a rebuilt machine without internet access.
