# System Design Write-up

Healthcare Appointment & Follow-up Manager

## Double-booking prevention

Slots are not stored as rows. They are derived on read from the doctor's working
hours, minus leave days, live locks, and times already past. Materialising every
slot would mean thousands of rows per doctor and a migration whenever a schedule
changes.

The one thing that *is* durable is the `slot_locks` table, which holds a unique
constraint on `(doctor_id, starts_at)`. That constraint is the entire
concurrency story. Booking opens a transaction, deletes any expired lock on that
exact slot, and inserts a fresh one. Two requests arriving in the same
millisecond both reach the insert; Postgres serialises them, one commits, the
other raises a unique violation which the service catches as Prisma error
`P2002` and converts into `409 SLOT_TAKEN`.

The alternative — `SELECT` to check availability, then `INSERT` — leaves a window
where both requests see an empty slot, and no amount of application-level care
closes it. Pushing the invariant into a database constraint means correctness
does not depend on request timing or on how many API instances are running.

## Slot hold mechanism

Booking is two steps because the symptom form sits between choosing a time and
confirming it. If the slot were only reserved on submit, two patients could fill
out forms for the same slot and one would lose their work.

`POST /appointments/hold` therefore reserves immediately, creating the lock with
`expires_at = now + 10 minutes` and an appointment in `HELD` status. The client
shows a live countdown. `POST /:id/confirm` saves the symptom form, promotes the
appointment to `CONFIRMED`, and pushes the lock's expiry to a far-future
sentinel — the same row, now meaning "booked" rather than "being booked".

Expiry is handled two ways. Reads treat a lock whose `expires_at` has passed,
with no confirmed appointment attached, as free. A cron sweep every two minutes
then cancels the abandoned appointment and deletes the lock. The read-side check
matters more: it means an abandoned hold stops blocking others the instant it
lapses, even if the sweep is late or the worker is down. The sweep also deletes
orphaned locks, which is what remains if the process dies between creating the
lock and creating the appointment.

## Doctor leave conflict handling

Marking leave on a day with bookings is destructive, so the API refuses to do it
silently. `POST /doctors/:id/leave` without `confirm: true` returns `409
LEAVE_HAS_BOOKINGS` along with the full list of affected patients and times. The
UI renders that list and only then offers a button that says how many
appointments will be cancelled. The doctor sees the damage before causing it.

On confirmation, each affected appointment is cancelled in its own transaction —
re-reading status first, so an appointment cancelled by the patient a moment
earlier is skipped rather than clobbered. Locks are released, calendar events
deleted, and each patient queued an email that includes the doctor's next three
open slots, computed at send time. Rebooking becomes one click instead of a
search.

Deactivating a doctor with upcoming appointments is refused outright, and
shrinking working hours never touches existing bookings, because those live on
locks rather than the schedule.

## Notification failure handling

No request handler sends email. Everything goes through a transactional outbox:
handlers insert a row into `notification_outbox`, and a worker drains it every
minute.

This gives three properties. A SendGrid outage cannot fail a booking, because
the booking transaction only writes a row. Nothing is lost, because the row
survives a crash. And retries are bounded and visible — six attempts with
backoff at 1, 5, 15, 60, 180 and 360 minutes, after which the row is marked
`DEAD` and surfaced on the admin dashboard with its last error, where it can be
requeued by hand.

Every row carries a `dedupeKey` under a unique index, so enqueueing is
idempotent. A worker restart mid-run, or a retried request, cannot produce a
duplicate email.

Google Calendar is treated as unreliable rather than transactional. Sync runs
after the booking commits and every failure is caught and logged; a reconcile
job every fifteen minutes finds confirmed appointments missing an event and
recreates it. A 404 from Google means the user deleted the event themselves, so
the stale pointer is dropped and the next sync recreates it.

The LLM gets the same treatment. `llm.service` never throws — on timeout,
malformed JSON, or a non-retryable 4xx it returns a deterministic keyword-triage
fallback, and the result is persisted with `llmStatus: FALLBACK`. The doctor's
screen then says the summary was not written by the AI and offers a retry
button, rather than presenting keyword matching as clinical reasoning. On the
post-visit side the fallback sends the doctor's own wording instead of inventing
patient-friendly text, which is the safe failure direction when the alternative
is a medication schedule that nobody wrote.
