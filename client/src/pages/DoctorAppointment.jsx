import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Alert, ErrorNote, Loading, Badge, Field } from '../components/ui.jsx';
import { longWhen, toDateInput } from '../lib/format.js';

const FREQUENCIES = [
  { value: 'ONCE_DAILY', label: 'Once a day (1-0-0)' },
  { value: 'TWICE_DAILY', label: 'Twice a day (1-0-1)' },
  { value: 'THRICE_DAILY', label: 'Three times a day (1-1-1)' },
  { value: 'FOUR_TIMES_DAILY', label: 'Four times a day' },
  { value: 'EVERY_OTHER_DAY', label: 'Every other day' },
  { value: 'WEEKLY', label: 'Once a week' },
  { value: 'AS_NEEDED', label: 'As needed (no reminders)' }
];

const blankMed = () => ({ name: '', dosage: '', frequency: 'TWICE_DAILY', durationDays: 5, instructions: '' });

export default function DoctorAppointment() {
  const { appointmentId } = useParams();
  const [appointment, setAppointment] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [retrying, setRetrying] = useState(false);

  const [form, setForm] = useState({
    clinicalNotes: '',
    diagnosis: '',
    followUpAt: '',
    followUpNotes: '',
    prescriptions: [blankMed()]
  });

  const load = () =>
    api
      .appointment(appointmentId)
      .then((r) => {
        setAppointment(r.appointment);
        const n = r.appointment.visitNote;
        if (n) {
          setForm({
            clinicalNotes: n.clinicalNotes || '',
            diagnosis: n.diagnosis || '',
            followUpAt: n.followUpAt ? toDateInput(new Date(n.followUpAt)) : '',
            followUpNotes: n.followUpNotes || '',
            prescriptions: n.prescriptions?.length ? n.prescriptions : [blankMed()]
          });
        }
      })
      .catch(setError);

  useEffect(() => {
    load();
  }, [appointmentId]);

  const setMed = (i, key, value) =>
    setForm((f) => {
      const next = [...f.prescriptions];
      next[i] = { ...next[i], [key]: value };
      return { ...f, prescriptions: next };
    });

  const retryTriage = async () => {
    setRetrying(true);
    setError(null);
    try {
      const r = await api.retryTriage(appointmentId);
      setAppointment((a) => ({ ...a, symptomReport: r.symptomReport }));
    } catch (err) {
      setError(err);
    } finally {
      setRetrying(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const prescriptions = form.prescriptions
        .filter((m) => m.name.trim())
        .map((m) => ({
          name: m.name.trim(),
          dosage: m.dosage || undefined,
          frequency: m.frequency,
          durationDays: m.durationDays ? Number(m.durationDays) : null,
          instructions: m.instructions || undefined
        }));

      const r = await api.submitVisitNote(appointmentId, {
        clinicalNotes: form.clinicalNotes.trim(),
        diagnosis: form.diagnosis || undefined,
        followUpAt: form.followUpAt ? new Date(`${form.followUpAt}T09:00:00`).toISOString() : null,
        followUpNotes: form.followUpNotes || undefined,
        prescriptions
      });
      setSaved(r);
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
  const report = a.symptomReport;
  const questions = report?.suggestedQuestions?.questions || [];
  const keyPoints = report?.suggestedQuestions?.keyPoints || [];

  return (
    <main className="page page-narrow">
      <div className="page-head">
        <p className="eyebrow">{a.status}</p>
        <h1>{a.patient?.fullName}</h1>
        <p className="mono">{longWhen(a.startsAt)}</p>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      {saved && (
        <Alert kind="ok" title="Notes filed">
          The patient has been emailed a plain-language summary
          {saved.remindersScheduled > 0 && `, and ${saved.remindersScheduled} medicine reminders are scheduled`}.
          {saved.note?.llmStatus === 'FALLBACK' && ' The AI rewrite was unavailable, so your own wording was sent.'}
        </Alert>
      )}

      {/* ---- pre-visit triage ---- */}
      {report ? (
        <div className={`appt u-${report.urgency || 'NONE'}`} style={{ marginBottom: 16 }}>
          <div className="spread" style={{ marginBottom: 10 }}>
            <h2>Before you see them</h2>
            <div className="row" style={{ gap: 6 }}>
              {report.urgency && <Badge tone={report.urgency}>{report.urgency}</Badge>}
              {report.llmStatus === 'FALLBACK' && <Badge>Keyword triage</Badge>}
            </div>
          </div>

          {report.llmStatus === 'FALLBACK' && (
            <Alert kind="warn" title="This summary was not written by the AI">
              The model was unavailable, so urgency came from keyword matching. Read the full symptom text below.
              <div style={{ marginTop: 8 }}>
                <button className="btn ghost small" onClick={retryTriage} disabled={retrying}>
                  {retrying ? 'Retrying…' : 'Retry AI summary'}
                </button>
              </div>
            </Alert>
          )}

          {report.chiefComplaint && (
            <p style={{ fontSize: '1.05rem', fontWeight: 600, marginTop: 0 }}>{report.chiefComplaint}</p>
          )}

          {keyPoints.length > 0 && (
            <ul className="questions small">
              {keyPoints.map((k, i) => (
                <li key={i}>{k}</li>
              ))}
            </ul>
          )}

          {questions.length > 0 && (
            <>
              <hr className="divider" />
              <h3 style={{ marginBottom: 8 }}>Suggested questions</h3>
              <ol className="questions">
                {questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
            </>
          )}

          <hr className="divider" />
          <h3 style={{ marginBottom: 6 }}>In the patient's words</h3>
          <p className="prose small tight">{report.symptomsText}</p>
          <dl className="kv small" style={{ marginTop: 12 }}>
            {report.durationDays != null && (
              <>
                <dt>Duration</dt>
                <dd className="mono">{report.durationDays} days</dd>
              </>
            )}
            {report.severity != null && (
              <>
                <dt>Self-rated</dt>
                <dd className="mono">{report.severity}/10</dd>
              </>
            )}
            {report.existingConditions && (
              <>
                <dt>Conditions</dt>
                <dd>{report.existingConditions}</dd>
              </>
            )}
            {report.currentMedications && (
              <>
                <dt>Medicines</dt>
                <dd>{report.currentMedications}</dd>
              </>
            )}
            {report.allergies && (
              <>
                <dt>Allergies</dt>
                <dd>{report.allergies}</dd>
              </>
            )}
          </dl>
        </div>
      ) : (
        <Alert kind="info">The patient has not submitted a symptom form for this appointment.</Alert>
      )}

      {/* ---- visit note ---- */}
      <form className="card" onSubmit={submit}>
        <div className="card-title">
          <h2>{a.visitNote ? 'Update your notes' : 'File your notes'}</h2>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Write clinically. The patient receives a plain-language rewrite, not this text.
        </p>

        <Field label="Clinical notes" hint="required">
          <textarea
            required
            minLength={10}
            value={form.clinicalNotes}
            onChange={(e) => setForm({ ...form, clinicalNotes: e.target.value })}
            placeholder="Examination findings, assessment, plan…"
          />
        </Field>

        <Field
          label="Diagnosis"
          hint="optional"
          value={form.diagnosis}
          onChange={(e) => setForm({ ...form, diagnosis: e.target.value })}
        />

        <h3 style={{ margin: '18px 0 10px' }}>Prescription</h3>
        {form.prescriptions.map((m, i) => (
          <div key={i} className="card" style={{ background: 'var(--surface-sunk)', marginBottom: 10, padding: 14 }}>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: '2 1 180px' }}>
                <Field
                  label="Medicine"
                  value={m.name}
                  onChange={(e) => setMed(i, 'name', e.target.value)}
                  placeholder="Amoxicillin"
                />
              </div>
              <div style={{ flex: '1 1 110px' }}>
                <Field
                  label="Dose"
                  value={m.dosage}
                  onChange={(e) => setMed(i, 'dosage', e.target.value)}
                  placeholder="500mg"
                />
              </div>
            </div>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: '2 1 200px' }}>
                <Field label="How often">
                  <select value={m.frequency} onChange={(e) => setMed(i, 'frequency', e.target.value)}>
                    {FREQUENCIES.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div style={{ flex: '1 1 100px' }}>
                <Field
                  label="Days"
                  type="number"
                  min="1"
                  max="90"
                  value={m.durationDays ?? ''}
                  onChange={(e) => setMed(i, 'durationDays', e.target.value)}
                />
              </div>
            </div>
            <Field
              label="Instructions"
              hint="optional"
              value={m.instructions}
              onChange={(e) => setMed(i, 'instructions', e.target.value)}
              placeholder="After food"
            />
            {form.prescriptions.length > 1 && (
              <button
                type="button"
                className="btn danger small"
                onClick={() =>
                  setForm((f) => ({ ...f, prescriptions: f.prescriptions.filter((_, j) => j !== i) }))
                }
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="btn ghost small"
          onClick={() => setForm((f) => ({ ...f, prescriptions: [...f.prescriptions, blankMed()] }))}
        >
          Add another medicine
        </button>

        <hr className="divider" />

        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 160px' }}>
            <Field
              label="Follow-up date"
              hint="optional"
              type="date"
              value={form.followUpAt}
              min={toDateInput()}
              onChange={(e) => setForm({ ...form, followUpAt: e.target.value })}
            />
          </div>
          <div style={{ flex: '2 1 220px' }}>
            <Field
              label="Follow-up notes"
              hint="optional"
              value={form.followUpNotes}
              onChange={(e) => setForm({ ...form, followUpNotes: e.target.value })}
              placeholder="Return sooner if fever persists past 3 days"
            />
          </div>
        </div>

        <button className="btn" disabled={busy}>
          {busy ? 'Filing…' : 'File notes and send summary'}
        </button>
      </form>

      <p className="small">
        <Link to="/doctor">Back to schedule</Link>
      </p>
    </main>
  );
}
