# API Reference

Base URL: `{SERVER_URL}/api`. All request and response bodies are JSON.

## Authentication

Send the JWT from login or registration as a bearer token:

```
Authorization: Bearer <token>
```

Roles are `PATIENT`, `DOCTOR`, `ADMIN`. Patients self-register; doctor and admin
accounts are created by an admin.

## Error format

Every failure uses the same envelope, so the client can render errors uniformly.

```json
{
  "error": {
    "code": "SLOT_TAKEN",
    "message": "Someone just took that slot. Pick another time.",
    "details": { "startsAt": "2026-09-01T03:30:00.000Z" }
  }
}
```

Validation failures return `details` as an array of `{ field, message }`.

| Code | Status | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Validation failed, or the slot is in the past |
| `UNAUTHORIZED` | 401 | Missing, invalid, or expired token |
| `FORBIDDEN` | 403 | Authenticated but not allowed to touch this record |
| `NOT_FOUND` | 404 | No such record |
| `SLOT_TAKEN` | 409 | Lost the race for that slot — refresh availability |
| `HOLD_EXPIRED` | 409 | The hold lapsed before confirmation |
| `PATIENT_DOUBLE_BOOKING` | 409 | Patient already has a booking at that time |
| `LEAVE_HAS_BOOKINGS` | 409 | Leave would cancel bookings; resend with `confirm: true` |
| `EMAIL_TAKEN` | 409 | Account already exists |
| `RATE_LIMITED` | 429 | Too many booking attempts |
| `INTERNAL` | 500 | Unhandled server error |

---

## Auth

### `POST /auth/register`
Public. Creates a patient account and returns a token.

```json
{ "fullName": "Rahul Sharma", "email": "rahul@example.com", "password": "Password@123", "phone": "+91 98400 11111" }
```

Response `201`: `{ "token": "...", "user": { "id", "email", "fullName", "role", "doctorProfileId" } }`

### `POST /auth/login`
Public. `{ "email", "password" }` → `{ "token", "user" }`.

### `GET /auth/me`
Any role. Returns the current user.

### `PATCH /auth/me`
Any role. `{ "fullName?", "phone?" }`.

---

## Doctor directory

### `GET /doctors`
Public. Query: `specialisation`, `q` (name or specialisation substring).

### `GET /doctors/specialisations`
Public. `{ "specialisations": [{ "name", "doctorCount" }] }`

### `GET /doctors/:doctorId`
Public. Full profile including working hours and upcoming leave.

### `GET /doctors/:doctorId/availability?date=YYYY-MM-DD`
Public. Slots are computed, not stored.

```json
{
  "date": "2026-09-01",
  "onLeave": false,
  "leaveReason": null,
  "slots": [
    { "startsAt": "2026-09-01T03:30:00.000Z", "endsAt": "2026-09-01T03:50:00.000Z", "status": "AVAILABLE" },
    { "startsAt": "2026-09-01T03:55:00.000Z", "endsAt": "2026-09-01T04:15:00.000Z", "status": "BOOKED" }
  ]
}
```

`status` is one of `AVAILABLE`, `HELD` (someone is mid-booking), `BOOKED`, `PAST`.
When `onLeave` is true, `slots` is empty.

### `GET /doctors/:doctorId/availability-range?from=YYYY-MM-DD&days=7`
Public. Open-slot counts per day, used for the date strip.

---

## Booking

Booking is deliberately two steps so the symptom form cannot be lost to a race.

### `POST /appointments/hold`
`PATIENT`, `ADMIN`. Rate limited to 20/minute. Reserves the slot for
`SLOT_HOLD_MINUTES` (default 10).

```json
{ "doctorId": "clx...", "startsAt": "2026-09-01T03:30:00.000Z", "reasonText": "Persistent cough" }
```

Response `201`: appointment with `status: "HELD"` and `holdExpiresAt`.
Returns `409 SLOT_TAKEN` if another request won the slot.

### `POST /appointments/:id/confirm`
`PATIENT`, `ADMIN`. Saves the symptom form and promotes the hold to `CONFIRMED`.

```json
{
  "symptomsText": "Dry cough for a week, worse at night, mild evening fever.",
  "durationDays": 7,
  "severity": 6,
  "existingConditions": "Asthma",
  "currentMedications": "Salbutamol inhaler as needed",
  "allergies": "Penicillin"
}
```

Only `symptomsText` (10–4000 chars) is required. Confirming triggers, after the
transaction commits: LLM triage, confirmation emails to both parties, and
calendar events. None of those can fail the booking.

Returns `409 HOLD_EXPIRED` if the hold lapsed — the client should re-select.

### `GET /appointments?scope=upcoming|past|all`
Any role. Scoped automatically: patients see their own, doctors see theirs,
admins see everything.

### `GET /appointments/:id`
Any role with access. Patients receive the friendly summary; the clinical triage
and suggested questions are stripped from their response.

### `POST /appointments/:id/cancel`
Patient, the treating doctor, or an admin. `{ "reason?": "..." }`. Releases the
lock, cancels pending medication reminders, queues emails, deletes calendar
events.

### `POST /appointments/:id/reschedule`
`{ "startsAt": "2026-09-02T04:00:00.000Z" }`. Acquires the new lock *before*
releasing the old one, so a failed move leaves the original booking intact.

### `POST /appointments/:id/retry-triage`
`DOCTOR`, `ADMIN`. Re-runs the LLM triage after a fallback.

---

## Doctor portal

### `GET /doctors/me/schedule`
`DOCTOR`. Next 14 days by default (`from`, `to` query params).

### `GET /doctors/:doctorId/leave/preview?date=YYYY-MM-DD`
`DOCTOR`, `ADMIN`. Non-destructive. Returns `affectedCount` and the appointments
that leave would cancel.

### `POST /doctors/:doctorId/leave`
`DOCTOR`, `ADMIN`.

```json
{ "date": "2026-09-01", "reason": "Conference", "confirm": true }
```

Without `confirm: true`, returns `409 LEAVE_HAS_BOOKINGS` with the impact
attached. With it, cancels each appointment and emails every patient the
doctor's next three open slots.

### `DELETE /doctors/:doctorId/leave/:date`
Removes a leave day.

### `POST /doctors/appointments/:appointmentId/visit-note`
`DOCTOR`, `ADMIN`. Files clinical notes, generates the patient-friendly rewrite,
schedules medication reminders, and emails the summary.

```json
{
  "clinicalNotes": "Viral URTI. Chest clear. No red flags. Symptomatic treatment advised.",
  "diagnosis": "Viral upper respiratory tract infection",
  "prescriptions": [
    { "name": "Paracetamol", "dosage": "650mg", "frequency": "TWICE_DAILY", "durationDays": 3, "instructions": "After food" }
  ],
  "followUpAt": "2026-09-08T09:00:00.000Z",
  "followUpNotes": "Return sooner if fever persists past 3 days"
}
```

`frequency` accepts `ONCE_DAILY`, `TWICE_DAILY`, `THRICE_DAILY`,
`FOUR_TIMES_DAILY`, `EVERY_OTHER_DAY`, `WEEKLY`, `AS_NEEDED`, and also parses
clinical shorthand — `1-0-1`, `BD`, `TDS`, `SOS`. `AS_NEEDED` schedules no
reminders.

Response: `{ "note": {...}, "remindersScheduled": 6 }`

---

## Admin

All require `ADMIN`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin/doctors` | List all doctors including inactive |
| `POST` | `/admin/doctors` | Create doctor account + profile + working hours |
| `PATCH` | `/admin/doctors/:id` | Update profile, hours, or active flag |
| `POST` | `/admin/doctors/:id/reset-password` | Set a new password |
| `DELETE` | `/admin/doctors/:id` | Deactivate — refused if upcoming appointments exist |
| `GET` | `/admin/overview` | Counts, queue health, LLM fallback count |
| `GET` | `/admin/notifications?status=` | Inspect the outbox |
| `POST` | `/admin/notifications/flush` | Drain the queue now |
| `POST` | `/admin/notifications/:id/retry` | Requeue a dead message |

Creating a doctor:

```json
{
  "fullName": "Ananya Rao",
  "email": "ananya.rao@meridian.health",
  "password": "Password@123",
  "specialisation": "General Medicine",
  "slotDurationMinutes": 20,
  "bufferMinutes": 5,
  "consultationFee": 600,
  "workingHours": [
    { "dayOfWeek": 1, "startMinute": 540, "endMinute": 780 }
  ]
}
```

`dayOfWeek` is 0=Sunday. Minutes are counted from local midnight in the doctor's
timezone — 540 is 09:00.

---

## Calendar

### `GET /calendar/status`
`{ "configured": true, "connected": false, "connectedAt": null }`

### `GET /calendar/google/connect`
Returns `{ "url" }` — the Google consent screen. The user id travels in the
OAuth `state` parameter.

### `GET /calendar/google/callback`
Google redirects here. Exchanges the code, stores the refresh token, then
redirects to `{CLIENT_URL}/settings?calendar=connected` or `?calendar=error`.

### `POST /calendar/google/disconnect`
Deletes the stored token.

### `POST /calendar/appointments/:id/sync`
Forces a re-sync for one appointment.

---

## Health

### `GET /health`
Public, unauthenticated. Returns `200` or `503`, and reports which integrations
are actually wired up.

```json
{
  "status": "ok",
  "database": "up",
  "integrations": { "llm": "configured", "googleCalendar": "not-configured", "email": "console" },
  "notifications": { "PENDING": 0, "SENT": 42, "DEAD": 0 }
}
```
