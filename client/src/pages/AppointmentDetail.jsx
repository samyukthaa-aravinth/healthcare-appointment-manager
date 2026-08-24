import { useEffect, useState } from 'react';
import { useParams, useLocation, useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Alert, ErrorNote, Loading, Badge, Empty } from '../components/ui.jsx';
import { longWhen, timeOf, toDateInput } from '../lib/format.js';

export default function AppointmentDetail() {
  const { appointmentId } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [appointment, setAppointment] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const [date, setDate] = useState(toDateInput());
  const [slots, setSlots] = useState(null);

  const load = () =>
    api
      .appointment(appointmentId)
      .then((r) => setAppointment(r.appointment))
      .catch(setError);

  useEffect(() => {
    load();
  }, [appointmentId]);

  useEffect(() => {
    if (!rescheduling || !appointment) return;
    setSlots(null);
    api
      .availability(appointment.doctor.id, date)
      .then((r) => setSlots(r.onLeave ? [] : r.slots.filter((s) => s.status === 'AVAILABLE')))
      .catch(() => setSlots([]));
  }, [rescheduling, date, appointment]);

  const cancel = async () => {
    const reason = window.prompt('Let the clinic know why you are cancelling (optional):') ?? undefined;
    setBusy(true);
    try {
      await api.cancel(appointmentId, reason);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const moveTo = async (startsAt) => {
    setBusy(true);
    setError(null);
    try {
      await api.reschedule(appointmentId, startsAt);
      setRescheduling(false);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (error && !appointment) return <main className="page page-narrow"><ErrorNote error={error} /></main>;
  if (!appointment) return <main className="page"><Loading rows={2} /></main>;

  const a = appointment;
  const note = a.visitNote;
  const upcoming = ['CONFIRMED', 'HELD'].includes(a.status) && new Date(a.startsAt) > new Date();

  return (
    <main className="page page-narrow">
      {location.state?.justBooked && (
        <Alert kind="ok" title="You are booked">
          A confirmation is on its way to your email, and the visit has been added to your calendar if you
          connected one.
        </Alert>
      )}

      <div className="page-head">
        <p className="eyebrow">{a.status}</p>
        <h1>Dr {a.doctor.fullName}</h1>
        <p className="mono">{longWhen(a.startsAt)}</p>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      {a.status === 'CANCELLED' && (
        <Alert kind="warn" title="This appointment was cancelled">
          {a.cancelReason || 'No reason was recorded.'}{' '}
          <Link to="/doctors">Book another slot</Link>
        </Alert>
      )}

      <div className="card">
        <dl className="kv">
          <dt>Specialisation</dt>
          <dd>{a.doctor.specialisation}</dd>
          <dt>Status</dt>
          <dd>
            <Badge tone={a.status === 'CONFIRMED' ? 'teal' : 'neutral'}>{a.status}</Badge>
          </dd>
          <dt>Reference</dt>
          <dd className="mono small">{a.id}</dd>
        </dl>

        {upcoming && (
          <>
            <hr className="divider" />
            <div className="row">
              <button className="btn ghost" onClick={() => setRescheduling((v) => !v)} disabled={busy}>
                {rescheduling ? 'Keep current time' : 'Reschedule'}
              </button>
              <button className="btn danger" onClick={cancel} disabled={busy}>
                Cancel appointment
              </button>
            </div>
          </>
        )}

        {rescheduling && (
          <div style={{ marginTop: 16 }}>
            <label className="field">
              <span>Move to</span>
              <input type="date" value={date} min={toDateInput()} onChange={(e) => setDate(e.target.value)} />
            </label>
            {slots === null ? (
              <Loading rows={1} />
            ) : slots.length === 0 ? (
              <p className="muted small">No open times that day. Try another date.</p>
            ) : (
              <div className="slot-grid">
                {slots.map((s) => (
                  <button
                    type="button"
                    key={s.startsAt}
                    className="slot"
                    disabled={busy}
                    onClick={() => moveTo(s.startsAt)}
                  >
                    {timeOf(s.startsAt)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {a.symptomReport && (
        <div className="card">
          <div className="card-title">
            <h2>What you told us</h2>
            {a.symptomReport.urgency && <Badge tone={a.symptomReport.urgency}>{a.symptomReport.urgency}</Badge>}
          </div>
          <p className="prose tight">{a.symptomReport.symptomsText}</p>
          {a.symptomReport.chiefComplaint && (
            <p className="muted small" style={{ marginBottom: 0 }}>
              Summarised for the doctor as: {a.symptomReport.chiefComplaint}
            </p>
          )}
        </div>
      )}

      {note?.patientSummary ? (
        <div className="card">
          <div className="card-title">
            <h2>Your visit summary</h2>
            {note.llmStatus === 'FALLBACK' && <Badge>Doctor's own words</Badge>}
          </div>
          <p className="prose">{note.patientSummary}</p>

          {note.medicationSchedule?.length > 0 && (
            <>
              <hr className="divider" />
              <h3 style={{ marginBottom: 10 }}>Your medicines</h3>
              <table>
                <thead>
                  <tr>
                    <th>Medicine</th>
                    <th>Dose</th>
                    <th>When</th>
                    <th>Days</th>
                  </tr>
                </thead>
                <tbody>
                  {note.medicationSchedule.map((m, i) => (
                    <tr key={i}>
                      <td>
                        <strong>{m.name}</strong>
                        {m.note && <div className="muted small">{m.note}</div>}
                      </td>
                      <td className="mono">{m.dosage || '—'}</td>
                      <td>{m.whenToTake || '—'}</td>
                      <td className="mono">{m.durationDays || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">
                We will email you a reminder each time a dose is due.
              </p>
            </>
          )}

          {note.followUpSteps?.length > 0 && (
            <>
              <hr className="divider" />
              <h3 style={{ marginBottom: 10 }}>What to do next</h3>
              <ul className="questions">
                {note.followUpSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : a.status === 'COMPLETED' ? (
        <Empty title="Summary on the way">
          Your doctor has not filed notes for this visit yet. You will get an email as soon as they do.
        </Empty>
      ) : null}

      {user?.role !== 'PATIENT' && (
        <p className="small">
          <Link to={`/doctor/appointments/${a.id}`}>Open the clinical view</Link>
        </p>
      )}
    </main>
  );
}
