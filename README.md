# Meridian Clinic — Healthcare Appointment & Follow-up Manager

A clinic platform with separate portals for patients, doctors and admin.
Patients book a slot and describe their symptoms; the doctor gets an AI triage
summary before the visit; the patient gets a plain-language summary after it.
Both sides are kept informed by email and Google Calendar.

Built with Node/Express, React, PostgreSQL and Prisma.

- **Live app:** _add your deployed URL here_
- **API health check:** `{API_URL}/api/health`

---

## What it does

**Patients** register, search doctors by specialisation, pick a slot from a live
availability grid, fill a symptom form, and later read a summary of their visit
with a medication schedule and reminder emails.

**Doctors** see their next fortnight ordered by time, with an urgency stripe on
each appointment derived from the AI triage — high-urgency patients are visible
without reading a word. They file clinical notes and a prescription; the system
turns that into patient-friendly text and schedules dose reminders. They can
mark leave, and see exactly who that would affect before confirming.

**Admins** create and manage doctor profiles, specialisation, working hours,
slot length and buffer, and monitor the notification queue and LLM fallback rate.

### The parts that were actually hard

| Problem | Approach |
|---|---|
| Two patients booking one slot simultaneously | Unique DB constraint on `(doctor_id, starts_at)` in `slot_locks`; the loser gets `409 SLOT_TAKEN` |
| Slot held while the symptom form is filled | Two-step booking with a 10-minute expiring lock, released on read *and* by a sweep |
| Doctor takes leave with patients booked | Preview endpoint shows the damage; commit cancels, releases locks, and emails alternatives |
| Email provider is down | Transactional outbox with idempotent dedupe keys and bounded backoff |
| LLM is down or returns garbage | Never throws — deterministic keyword fallback, persisted `llmStatus`, honest labelling in the UI |

Details are in [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md).

---

## Running it locally

### Requirements

- Node 20 or newer
- PostgreSQL 14+ (local, Docker, or a free Neon/Supabase database)

### 1. Database

Either point at a hosted Postgres, or start one with Docker:

```bash
docker compose up -d
```

### 2. Backend

```bash
cd server
cp .env.example .env          # then edit DATABASE_URL and JWT_SECRET
npm install
npx prisma db push            # creates the tables
npm run seed                  # demo doctors, patients and an admin
npm run dev                   # http://localhost:4000
```

### 3. Frontend

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

The dev server proxies `/api` to `localhost:4000`, so no CORS setup is needed
locally.

### 4. Sign in

| Role | Email | Password |
|---|---|---|
| Admin | `admin@meridian.health` | `Admin@12345` |
| Doctor | `ananya.rao@meridian.health` | `Password@123` |
| Patient | `rahul@example.com` | `Password@123` |

**It runs with zero third-party keys.** Without `ANTHROPIC_API_KEY` the triage
falls back to keyword matching and says so; with `EMAIL_TRANSPORT=console`
emails render into the server log instead of sending. Add keys to turn each
integration on.

### Tests

```bash
cd server && npm test
```

35 tests covering slot maths across timezones and DST, the triage fallback,
LLM response parsing, and prescription-to-reminder expansion. No database
required.

---

## Environment variables

Full list with comments in [`server/.env.example`](server/.env.example). The
ones that matter:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Signing secret — use a long random string |
| `CLIENT_URL` / `SERVER_URL` | Used for email links and the OAuth redirect |
| `SLOT_HOLD_MINUTES` | How long a slot is held during booking (default 10) |
| `ANTHROPIC_API_KEY` | Leave blank to run on the fallback triage |
| `EMAIL_TRANSPORT` | `console`, `smtp`, or `sendgrid` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Calendar sync |
| `RUN_WORKER_IN_PROCESS` | `true` runs cron jobs inside the API process |

Client: `VITE_API_URL` — blank locally, set to the API origin in production.

---

## Database schema

Twelve tables. `slot_locks` is the load-bearing one.

```
users ──┬── doctor_profiles ──┬── working_hours
        │                     ├── doctor_leaves
        │                     └── slot_locks ──┐
        ├── calendar_accounts                  │
        └── appointments ──────────────────────┘
                 ├── symptom_reports    (patient symptoms + AI triage)
                 ├── visit_notes        (clinical notes + AI rewrite)
                 ├── medication_reminders
                 └── calendar_events

notification_outbox   (standalone — every email queues here first)
```

| Table | Notes |
|---|---|
| `users` | One table for all three roles, discriminated by `role` |
| `doctor_profiles` | Specialisation, slot length, buffer, timezone |
| `working_hours` | One row per weekday window; a doctor can have morning and evening windows |
| `doctor_leaves` | Unique on `(doctor_id, date)` |
| `slot_locks` | **Unique on `(doctor_id, starts_at)` — this prevents double-booking.** `expires_at` distinguishes a live hold from a confirmed booking |
| `appointments` | `HELD` → `CONFIRMED` → `COMPLETED`, or `CANCELLED` |
| `symptom_reports` | Patient input plus urgency, chief complaint, suggested questions, and `llm_status` |
| `visit_notes` | Clinical notes plus the patient-friendly rewrite and `llm_status` |
| `medication_reminders` | One row per scheduled dose |
| `notification_outbox` | Unique `dedupe_key` makes enqueueing idempotent |
| `calendar_accounts` | Google refresh token per user |
| `calendar_events` | Maps an appointment to each participant's Google event |

Full definitions with comments: [`server/prisma/schema.prisma`](server/prisma/schema.prisma).

Slots themselves are **not** stored — they are computed from working hours minus
leave minus locks. Storing them would mean thousands of rows per doctor and a
migration every time a schedule changed.

---

## LLM prompts

Both prompts live in [`server/src/services/llm.service.js`](server/src/services/llm.service.js)
and are forced to return JSON only.

### Pre-visit triage

System prompt sets the guardrails — intake assistant, does not diagnose, does
not recommend treatment — and pins the output shape:

```
{ "urgency": "Low"|"Medium"|"High",
  "chiefComplaint": string,
  "suggestedQuestions": [string, string, string],
  "keyPoints": [string] }
```

Urgency is defined explicitly rather than left to the model's judgement: High is
red-flag symptoms needing same-day review, Medium is persistent or worsening,
Low is routine. Thin information defaults to Medium, which fails safe.

User message:

```
Analyse these symptoms and return urgency level (Low / Medium / High), chief
complaint, and three suggested questions for the doctor.

Symptoms: <symptoms>
Duration: <n> day(s)
Patient-rated severity: <n>/10
Existing conditions: <...>
Current medications: <...>
Allergies: <...>
```

### Post-visit summary

System prompt: rewrite at roughly a 10-year-old reading level, no new medical
advice, no dosages the doctor did not write, copy medication names exactly.

```
{ "patientSummary": string,
  "medicationSchedule": [{ "name", "dosage", "whenToTake", "durationDays", "note" }],
  "followUpSteps": [string] }
```

User message:

```
Convert these clinical notes into a patient-friendly summary with medication
schedule and follow-up steps.

Clinical notes: <notes>
Diagnosis: <diagnosis>
Prescription:
- <name> <dosage>, <frequency> for <n> days (<instructions>)
Follow-up date: <date>
```

### Failure handling

`generatePreVisitSummary` and `generatePostVisitSummary` never throw. They:

1. Retry twice with exponential backoff, failing fast on non-retryable 4xx
2. Abort on a 20-second timeout
3. Extract JSON tolerantly — bare, fenced, or after a chatty preamble
4. Validate the parsed shape, and reject it if urgency or chief complaint is missing
5. Fall back to deterministic logic and return `status: 'FALLBACK'`

The fallback is stored as `llm_status = FALLBACK`, and the doctor's screen says
plainly that the summary was not written by the AI, with a retry button. The
post-visit fallback sends the doctor's own wording rather than inventing
patient-friendly text — the safe direction when the alternative is a medication
schedule nobody wrote.

---

## Google Calendar setup

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create
   a project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → External. Fill in app name and
   support email. Add the scope
   `https://www.googleapis.com/auth/calendar.events`. While the app is in
   Testing, add every account you plan to sign in with under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application.**
5. Under **Authorised redirect URIs**, add exactly:
   - `http://localhost:4000/api/calendar/google/callback` for local development
   - `https://<your-api-host>/api/calendar/google/callback` for production
6. Copy the client ID and secret into `server/.env` as `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, and set `GOOGLE_REDIRECT_URI` to the matching URI.
7. Restart the API. Each user connects their own calendar from **Settings →
   Connect Google Calendar**.

Events are created on both the patient's and the doctor's calendars at booking,
updated on reschedule, and deleted on cancellation. The doctor's event includes
the chief complaint and urgency; the patient's includes a link to manage the
booking.

**If the redirect URI does not match character for character, Google returns
`redirect_uri_mismatch`.** That is the usual cause of a failed connect.

A reconcile job runs every 15 minutes and recreates events for confirmed
appointments that are missing one, which is what repairs a Google outage.

---

## Background jobs

Cron jobs run inside the API process by default, which suits single-process free
hosting. Set `RUN_WORKER_IN_PROCESS=false` and run `npm run worker` separately to
scale them out. Each job is guarded against overlapping runs.

| Job | Frequency | Purpose |
|---|---|---|
| `outbox` | 1 min | Send queued emails, retry failures with backoff |
| `expire-holds` | 2 min | Release slots whose hold lapsed, clean orphaned locks |
| `medication-reminders` | 5 min | Queue dose reminders that have come due |
| `appointment-reminders` | hourly | Queue 24-hour reminders |
| `calendar-reconcile` | 15 min | Recreate calendar events missed during an outage |

One-shot run for testing: `npm run worker -- --once`.

---

## Deployment

The app is two services. Any free host works; Render plus Vercel is the
shortest path.

### Database
Create a free Postgres on [Neon](https://neon.tech) or
[Supabase](https://supabase.com) and copy the connection string.

### API (Render)
- New **Web Service**, root directory `server`
- Build: `npm install && npx prisma generate && npx prisma db push`
- Start: `npm start`
- Environment: everything from `.env.example`. Set `NODE_ENV=production`,
  `CLIENT_URL` to the deployed frontend, and `SERVER_URL` to the Render URL.
- Seed once from the Render shell: `npm run seed`

`render.yaml` is included if you prefer a blueprint deploy.

### Frontend (Vercel)
- Root directory `client`, framework Vite
- Environment: `VITE_API_URL=https://<your-api>.onrender.com`
- `vercel.json` is included so client-side routes resolve on refresh

### After deploying
Set `GOOGLE_REDIRECT_URI` to the production callback and add the same URI in
Google Cloud Console. Then check `{API_URL}/api/health` — it reports which
integrations are live.

Free Render instances sleep when idle, so the first request after a quiet period
takes a few seconds, and background jobs pause while asleep.

---

## Project layout

```
server/
  prisma/schema.prisma        data model
  prisma/seed.js              demo data
  src/services/
    slot.service.js           availability computation
    booking.service.js        holds, confirm, cancel, reschedule, leave
    llm.service.js            prompts, retries, fallbacks
    notification.service.js   transactional outbox
    calendar.service.js       Google OAuth and event sync
    visit.service.js          visit notes, reminder scheduling
  src/jobs/worker.js          cron jobs
  tests/logic.test.mjs        unit tests
client/
  src/pages/                  one file per screen
  src/components/ui.jsx       shared UI
  src/lib/api.js              typed API client
docs/
  SYSTEM_DESIGN.md            the 800-word write-up
  API.md                      full endpoint reference
```

---

## Known limitations

Honest list of what is not there:

- Refresh tokens are stored in plaintext — a real deployment should encrypt them at rest
- No pagination on appointment lists (capped at 100)
- Reminder dose times are fixed per frequency (09:00, 21:00 and so on) rather than patient-configurable
- Email only; no SMS or push
- No automated end-to-end browser tests
