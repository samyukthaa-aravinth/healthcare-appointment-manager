import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Field, ErrorNote, Alert, Loading, Empty, Badge } from '../components/ui.jsx';
import { timeOf, toDateInput, addDays, longWhen } from '../lib/format.js';

/** Counts down the slot hold so the patient knows the clock is running. */
function HoldTimer({ expiresAt, onExpire }) {
  const [left, setLeft] = useState(() => Math.max(0, new Date(expiresAt) - Date.now()));

  useEffect(() => {
    const id = setInterval(() => {
      const remaining = Math.max(0, new Date(expiresAt) - Date.now());
      setLeft(remaining);
      if (remaining === 0) onExpire?.();
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt, onExpire]);

  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  return (
    <span className="mono">
      {mins}:{String(secs).padStart(2, '0')}
    </span>
  );
}

export default function BookAppointment() {
  const { doctorId } = useParams();
  const navigate = useNavigate();

  const [doctor, setDoctor] = useState(null);
  const [date, setDate] = useState(toDateInput());
  const [days, setDays] = useState([]);
  const [availability, setAvailability] = useState(null);
  const [selected, setSelected] = useState(null);
  const [held, setHeld] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    symptomsText: '',
    durationDays: '',
    severity: 5,
    existingConditions: '',
    currentMedications: '',
    allergies: ''
  });

  useEffect(() => {
    api.doctor(doctorId).then((r) => setDoctor(r.doctor)).catch(setError);
  }, [doctorId]);

  useEffect(() => {
    api.availabilityRange(doctorId, toDateInput(), 10).then((r) => setDays(r.days)).catch(() => {});
  }, [doctorId]);

  const loadDay = useCallback(() => {
    setAvailability(null);
    setSelected(null);
    api
      .availability(doctorId, date)
      .then(setAvailability)
      .catch((err) => {
        setError(err);
        setAvailability({ slots: [] });
      });
  }, [doctorId, date]);

  useEffect(loadDay, [loadDay]);

  const holdSlot = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.hold({ doctorId, startsAt: selected });
      setHeld(r.appointment);
    } catch (err) {
      setError(err);
      // Someone else took it — refresh the grid so the UI tells the truth.
      if (err.code === 'SLOT_TAKEN') loadDay();
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        symptomsText: form.symptomsText.trim(),
        severity: Number(form.severity),
        ...(form.durationDays !== '' ? { durationDays: Number(form.durationDays) } : {}),
        ...(form.existingConditions ? { existingConditions: form.existingConditions } : {}),
        ...(form.currentMedications ? { currentMedications: form.currentMedications } : {}),
        ...(form.allergies ? { allergies: form.allergies } : {})
      };
      const r = await api.confirm(held.id, body);
      navigate(`/appointments/${r.appointment.id}`, { state: { justBooked: true } });
    } catch (err) {
      setError(err);
      if (err.code === 'HOLD_EXPIRED') {
        setHeld(null);
        loadDay();
      }
    } finally {
      setBusy(false);
    }
  };

  const releaseHold = async () => {
    if (held) await api.cancel(held.id, 'Changed my mind before confirming').catch(() => {});
    setHeld(null);
    loadDay();
  };

  if (error && !doctor) return <main className="page page-narrow"><ErrorNote error={error} /></main>;
  if (!doctor) return <main className="page"><Loading rows={2} /></main>;

  /* ---------- step 2: symptom form ---------- */
  if (held) {
    return (
      <main className="page page-narrow">
        <div className="page-head">
          <p className="eyebrow">Step 2 of 2</p>
          <h1>Tell the doctor what is wrong</h1>
          <p>
            Dr {doctor.fullName} reads a summary of this before you arrive, so the visit starts with the
            important part.
          </p>
        </div>

        <Alert kind="info">
          <strong className="mono">{longWhen(held.startsAt)}</strong> is held for you —{' '}
          <HoldTimer expiresAt={held.holdExpiresAt} onExpire={() => setHeld(null)} /> left to confirm.
        </Alert>

        <ErrorNote error={error} onDismiss={() => setError(null)} />

        <form className="card" onSubmit={confirm}>
          <Field label="What are you experiencing?" hint="in your own words">
            <textarea
              required
              minLength={10}
              placeholder="For example: dry cough for the past week, worse at night, mild fever in the evenings."
              value={form.symptomsText}
              onChange={(e) => setForm({ ...form, symptomsText: e.target.value })}
            />
          </Field>

          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 160px' }}>
              <Field
                label="How many days"
                type="number"
                min="0"
                max="3650"
                value={form.durationDays}
                onChange={(e) => setForm({ ...form, durationDays: e.target.value })}
              />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <Field label="How bad is it?" hint={`${form.severity} of 10`}>
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={form.severity}
                  onChange={(e) => setForm({ ...form, severity: e.target.value })}
                />
              </Field>
            </div>
          </div>

          <Field label="Ongoing conditions" hint="optional">
            <input
              placeholder="Diabetes, asthma, high blood pressure…"
              value={form.existingConditions}
              onChange={(e) => setForm({ ...form, existingConditions: e.target.value })}
            />
          </Field>
          <Field label="Medicines you take now" hint="optional">
            <input
              placeholder="Metformin 500mg twice a day…"
              value={form.currentMedications}
              onChange={(e) => setForm({ ...form, currentMedications: e.target.value })}
            />
          </Field>
          <Field label="Allergies" hint="optional">
            <input
              placeholder="Penicillin, sulfa drugs…"
              value={form.allergies}
              onChange={(e) => setForm({ ...form, allergies: e.target.value })}
            />
          </Field>

          <div className="row">
            <button className="btn" disabled={busy}>
              {busy ? 'Confirming…' : 'Confirm appointment'}
            </button>
            <button type="button" className="btn ghost" onClick={releaseHold} disabled={busy}>
              Pick a different time
            </button>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Confirming books the slot, emails you and your doctor, and adds the visit to both calendars.
          </p>
        </form>
      </main>
    );
  }

  /* ---------- step 1: pick a slot ---------- */
  const openSlots = availability?.slots?.filter((s) => s.status === 'AVAILABLE') || [];

  return (
    <main className="page">
      <div className="page-head">
        <p className="eyebrow">Step 1 of 2</p>
        <h1>Dr {doctor.fullName}</h1>
        <p>
          {doctor.specialisation} · {doctor.slotDurationMinutes} minute appointments
          {doctor.consultationFee ? ` · ₹${doctor.consultationFee}` : ''}
        </p>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <div className="card">
        <div className="card-title">
          <h2>Pick a day</h2>
          <input
            type="date"
            style={{ width: 'auto' }}
            value={date}
            min={toDateInput()}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div className="daystrip" role="group" aria-label="Choose a date">
          {days.map((d) => {
            const label = new Date(`${d.date}T12:00:00`);
            return (
              <button
                type="button"
                key={d.date}
                className={`day ${d.onLeave ? 'leave' : ''}`}
                aria-pressed={d.date === date}
                onClick={() => setDate(d.date)}
              >
                {label.toLocaleDateString('en-GB', { weekday: 'short' })}
                <strong>{label.getDate()}</strong>
                <small>{d.onLeave ? 'on leave' : d.openCount ? `${d.openCount} open` : 'full'}</small>
              </button>
            );
          })}
        </div>

        <hr className="divider" />

        {availability === null ? (
          <Loading rows={2} />
        ) : availability.onLeave ? (
          <Alert kind="warn" title="Dr is on leave that day">
            {availability.leaveReason || 'No appointments are available on this date.'} Pick another day from the
            strip above.
          </Alert>
        ) : availability.slots.length === 0 ? (
          <Empty title="No clinic hours on this day">
            Dr {doctor.fullName} does not hold clinic on this weekday. Try one of the highlighted days.
          </Empty>
        ) : (
          <>
            <div className="spread" style={{ marginBottom: 12 }}>
              <p className="muted small tight">
                {openSlots.length} of {availability.slots.length} slots open
              </p>
              <div className="row small muted" style={{ gap: 12 }}>
                <span>
                  <Badge tone="teal">Open</Badge>
                </span>
                <span className="mono" style={{ textDecoration: 'line-through' }}>
                  taken
                </span>
              </div>
            </div>
            <div className="slot-grid" role="group" aria-label="Available times">
              {availability.slots.map((s) => {
                const open = s.status === 'AVAILABLE';
                return (
                  <button
                    type="button"
                    key={s.startsAt}
                    className={`slot ${open ? '' : 'taken'}`}
                    disabled={!open}
                    aria-pressed={selected === s.startsAt}
                    title={
                      s.status === 'HELD'
                        ? 'Someone is booking this right now'
                        : s.status === 'BOOKED'
                          ? 'Already booked'
                          : s.status === 'PAST'
                            ? 'This time has passed'
                            : 'Available'
                    }
                    onClick={() => setSelected(s.startsAt)}
                  >
                    {timeOf(s.startsAt)}
                  </button>
                );
              })}
            </div>

            <div className="row" style={{ marginTop: 18 }}>
              <button className="btn" disabled={!selected || busy} onClick={holdSlot}>
                {busy ? 'Holding…' : selected ? `Hold ${timeOf(selected)} and continue` : 'Select a time'}
              </button>
              <button type="button" className="btn ghost" onClick={loadDay} disabled={busy}>
                Refresh times
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
