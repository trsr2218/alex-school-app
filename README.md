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

## Demo Roles

- Student: `student@vfu.local` / `student123`
- Lecturer: `lecturer@vfu.local` / `lecturer123`
- Admin: `admin@vfu.local` / `admin123`

The login form pre-fills the password for whichever role is selected.

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
