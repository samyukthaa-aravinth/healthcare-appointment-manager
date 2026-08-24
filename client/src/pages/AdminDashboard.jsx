import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Alert, ErrorNote, Loading, Badge, Field, Stat, Empty } from '../components/ui.jsx';
import { DAY_NAMES, minutesToClock, clockToMinutes } from '../lib/format.js';

const DEFAULT_HOURS = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  enabled: true,
  start: '09:00',
  end: '13:00'
}));

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => {
  const preset = DEFAULT_HOURS.find((d) => d.dayOfWeek === dayOfWeek);
  return preset || { dayOfWeek, enabled: false, start: '09:00', end: '13:00' };
});

function DoctorForm({ onCreated }) {
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    specialisation: '',
    qualification: '',
    bio: '',
    consultationFee: 500,
    slotDurationMinutes: 30,
    bufferMinutes: 0
  });
  const [hours, setHours] = useState(ALL_DAYS);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setDay = (dow, key, value) =>
    setHours((h) => h.map((d) => (d.dayOfWeek === dow ? { ...d, [key]: value } : d)));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const workingHours = hours
        .filter((d) => d.enabled)
        .map((d) => ({
          dayOfWeek: d.dayOfWeek,
          startMinute: clockToMinutes(d.start),
          endMinute: clockToMinutes(d.end)
        }))
        .filter((w) => w.endMinute > w.startMinute);

      await api.createDoctor({
        ...form,
        consultationFee: Number(form.consultationFee),
        slotDurationMinutes: Number(form.slotDurationMinutes),
        bufferMinutes: Number(form.bufferMinutes),
        qualification: form.qualification || undefined,
        bio: form.bio || undefined,
        workingHours
      });
      setForm({ ...form, fullName: '', email: '', password: '', specialisation: '', qualification: '', bio: '' });
      onCreated?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <div className="card-title">
        <h2>Add a doctor</h2>
      </div>
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 200px' }}>
          <Field label="Full name" required value={form.fullName} onChange={set('fullName')} />
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <Field label="Specialisation" required value={form.specialisation} onChange={set('specialisation')} />
        </div>
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 200px' }}>
          <Field label="Email" type="email" required value={form.email} onChange={set('email')} />
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <Field
            label="Temporary password"
            hint="min 8 characters"
            type="text"
            minLength={8}
            required
            value={form.password}
            onChange={set('password')}
          />
        </div>
      </div>
      <Field label="Qualification" hint="optional" value={form.qualification} onChange={set('qualification')} />
      <Field label="Short bio" hint="optional">
        <textarea value={form.bio} onChange={set('bio')} style={{ minHeight: 64 }} />
      </Field>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 130px' }}>
          <Field label="Slot length" hint="minutes" type="number" min="5" max="240" value={form.slotDurationMinutes} onChange={set('slotDurationMinutes')} />
        </div>
        <div style={{ flex: '1 1 130px' }}>
          <Field label="Gap between" hint="minutes" type="number" min="0" max="120" value={form.bufferMinutes} onChange={set('bufferMinutes')} />
        </div>
        <div style={{ flex: '1 1 130px' }}>
          <Field label="Fee" hint="₹" type="number" min="0" value={form.consultationFee} onChange={set('consultationFee')} />
        </div>
      </div>

      <h3 style={{ margin: '16px 0 10px' }}>Clinic hours</h3>
      <table>
        <tbody>
          {hours.map((d) => (
            <tr key={d.dayOfWeek}>
              <td style={{ width: 130 }}>
                <label className="row" style={{ gap: 8, marginBottom: 0 }}>
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    onChange={(e) => setDay(d.dayOfWeek, 'enabled', e.target.checked)}
                  />
                  {DAY_NAMES[d.dayOfWeek]}
                </label>
              </td>
              <td>
                <input
                  type="time"
                  value={d.start}
                  disabled={!d.enabled}
                  onChange={(e) => setDay(d.dayOfWeek, 'start', e.target.value)}
                />
              </td>
              <td>
                <input
                  type="time"
                  value={d.end}
                  disabled={!d.enabled}
                  onChange={(e) => setDay(d.dayOfWeek, 'end', e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button className="btn" disabled={busy} style={{ marginTop: 16 }}>
        {busy ? 'Creating…' : 'Create doctor'}
      </button>
    </form>
  );
}

function Outbox() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.notifications().then((r) => setRows(r.notifications)).catch(setError);
  useEffect(load, []);

  const flush = async () => {
    setBusy(true);
    try {
      await api.flushNotifications();
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const retry = async (id) => {
    await api.retryNotification(id).catch(setError);
    await load();
  };

  const tone = { SENT: 'LOW', PENDING: 'neutral', FAILED: 'MEDIUM', DEAD: 'HIGH' };

  return (
    <div className="card">
      <div className="card-title">
        <h2>Notification queue</h2>
        <button className="btn ghost small" onClick={flush} disabled={busy}>
          {busy ? 'Sending…' : 'Send pending now'}
        </button>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Every email is queued here first, then retried with backoff. Anything marked dead has used up its
        attempts and needs a look.
      </p>
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      {rows === null ? (
        <Loading rows={2} />
      ) : rows.length === 0 ? (
        <Empty title="Queue is empty">Notifications will show up here as they are created.</Empty>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Template</th>
                <th>To</th>
                <th>Status</th>
                <th>Tries</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 25).map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{r.template}</td>
                  <td className="small">{r.toEmail}</td>
                  <td>
                    <Badge tone={tone[r.status] || 'neutral'}>{r.status}</Badge>
                    {r.lastError && <div className="muted small">{r.lastError.slice(0, 60)}</div>}
                  </td>
                  <td className="mono">{r.attempts}</td>
                  <td>
                    {['FAILED', 'DEAD'].includes(r.status) && (
                      <button className="btn ghost small" onClick={() => retry(r.id)}>
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AdminDashboard() {
  const [overview, setOverview] = useState(null);
  const [doctors, setDoctors] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    api.overview().then(setOverview).catch(setError);
    api.adminDoctors().then((r) => setDoctors(r.doctors)).catch(setError);
  };
  useEffect(load, []);

  const deactivate = async (id) => {
    if (!window.confirm('Deactivate this doctor? They will stop appearing in search.')) return;
    try {
      await api.deactivateDoctor(id);
      load();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <p className="eyebrow">Clinic administration</p>
        <h1>Overview</h1>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      {overview && (
        <>
          <div className="grid grid-3" style={{ marginBottom: 14 }}>
            <Stat label="Doctors" value={overview.doctors} />
            <Stat label="Patients" value={overview.patients} />
            <Stat label="Upcoming visits" value={overview.upcomingAppointments} />
            <Stat label="Slots on hold" value={overview.activeHolds} />
            <Stat label="Emails waiting" value={overview.notifications?.PENDING || 0} />
            <Stat label="Emails dead" value={overview.notifications?.DEAD || 0} />
          </div>
          {overview.llmFallbacks > 0 && (
            <Alert kind="warn" title="Some summaries fell back to keyword triage">
              {overview.llmFallbacks} symptom report(s) were written without the AI. Check the API key and model
              settings if this number keeps climbing.
            </Alert>
          )}
        </>
      )}

      <div className="card">
        <div className="card-title">
          <h2>Doctors</h2>
        </div>
        {doctors === null ? (
          <Loading rows={2} />
        ) : doctors.length === 0 ? (
          <Empty title="No doctors yet">Add your first doctor below.</Empty>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Specialisation</th>
                  <th>Hours</th>
                  <th>Leave</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {doctors.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <strong>Dr {d.fullName}</strong>
                      <div className="muted small">{d.email}</div>
                      {!d.isActive && <Badge>Inactive</Badge>}
                    </td>
                    <td>{d.specialisation}</td>
                    <td className="mono small">
                      {d.workingHours?.length
                        ? d.workingHours
                            .map((w) => `${DAY_NAMES[w.dayOfWeek].slice(0, 3)} ${minutesToClock(w.startMinute)}`)
                            .join(', ')
                        : 'none set'}
                    </td>
                    <td className="mono small">
                      {d.leaves?.length ? d.leaves.map((l) => l.date).join(', ') : '—'}
                    </td>
                    <td>
                      {d.isActive && (
                        <button className="btn danger small" onClick={() => deactivate(d.id)}>
                          Deactivate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DoctorForm onCreated={load} />
      <Outbox />
    </main>
  );
}
