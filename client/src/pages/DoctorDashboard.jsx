import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { AppointmentCard, Loading, Empty, ErrorNote, Alert, Stat, Field } from '../components/ui.jsx';
import { toDateInput, dateOf } from '../lib/format.js';

/** Marking leave shows the damage first, then asks for confirmation. */
function LeavePanel({ doctorId, onDone }) {
  const [date, setDate] = useState(toDateInput());
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const check = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setPreview(await api.leavePreview(doctorId, date));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.markLeave(doctorId, { date, reason: reason || undefined, confirm: true });
      setDone(r);
      setPreview(null);
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-title">
        <h2>Mark a day off</h2>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Patients already booked that day are cancelled and emailed automatically, with your next open slots
        included so they can rebook in one step.
      </p>

      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {done && (
        <Alert kind="ok" title="Leave recorded">
          {done.cancelledCount
            ? `${done.cancelledCount} appointment(s) cancelled and those patients have been emailed.`
            : 'No appointments were affected.'}
        </Alert>
      )}

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 160px' }}>
          <Field label="Date" type="date" value={date} min={toDateInput()} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div style={{ flex: '2 1 220px' }}>
          <Field
            label="Reason"
            hint="shown to patients"
            placeholder="Conference, personal leave…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <button className="btn ghost" onClick={check} disabled={busy} style={{ marginBottom: 14 }}>
          Check impact
        </button>
      </div>

      {preview && (
        <>
          {preview.affectedCount === 0 ? (
            <Alert kind="info">Nothing is booked on {dateOf(`${date}T12:00:00`)} — safe to take off.</Alert>
          ) : (
            <Alert kind="warn" title={`${preview.affectedCount} patient(s) are booked that day`}>
              Confirming will cancel these appointments and email each patient.
              <ul>
                {preview.appointments.map((a) => (
                  <li key={a.id}>
                    {a.slotLabel} — {a.patient.fullName}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          <button className="btn" onClick={commit} disabled={busy}>
            {busy
              ? 'Working…'
              : preview.affectedCount
                ? `Cancel ${preview.affectedCount} and mark leave`
                : 'Mark leave'}
          </button>
        </>
      )}
    </div>
  );
}

export default function DoctorDashboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    setData(null);
    api.mySchedule().then(setData).catch(setError);
  };

  useEffect(load, []);

  const grouped = useMemo(() => {
    if (!data) return [];
    const map = new Map();
    for (const a of data.appointments) {
      const key = toDateInput(new Date(a.startsAt));
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  const counts = useMemo(() => {
    const list = data?.appointments || [];
    return {
      total: list.length,
      high: list.filter((a) => a.symptomReport?.urgency === 'HIGH').length,
      pending: list.filter((a) => a.status === 'CONFIRMED' && new Date(a.startsAt) < new Date()).length
    };
  }, [data]);

  if (error) return <main className="page"><ErrorNote error={error} /></main>;
  if (!data) return <main className="page"><Loading /></main>;

  return (
    <main className="page">
      <div className="page-head">
        <p className="eyebrow">Next 14 days</p>
        <h1>Dr {user.fullName}</h1>
        <p>
          Appointments are ordered by time; the coloured spine is the urgency the intake summary assigned.
          Red stripes want your attention first.
        </p>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <Stat label="Booked" value={counts.total} />
        <Stat label="High urgency" value={counts.high} />
        <Stat label="Awaiting your notes" value={counts.pending} />
      </div>

      {grouped.length === 0 ? (
        <Empty title="Nothing booked in the next two weeks">
          Patients will appear here as soon as they book.
        </Empty>
      ) : (
        <div className="stack" style={{ marginBottom: 24 }}>
          {grouped.map(([day, items]) => (
            <section key={day}>
              <p className="eyebrow" style={{ marginTop: 10 }}>
                {dateOf(`${day}T12:00:00`)} · {items.length} appointment{items.length > 1 ? 's' : ''}
              </p>
              <div className="stack">
                {items.map((a) => (
                  <AppointmentCard
                    key={a.id}
                    appointment={a}
                    to={`/doctor/appointments/${a.id}`}
                    perspective="DOCTOR"
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <LeavePanel doctorId={data.doctor.id} onDone={load} />
    </main>
  );
}
