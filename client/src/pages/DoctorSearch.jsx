import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Loading, Empty, ErrorNote, Badge } from '../components/ui.jsx';
import { DAY_NAMES, minutesToClock } from '../lib/format.js';

const scheduleSummary = (workingHours = []) => {
  if (!workingHours.length) return 'No clinic hours set yet';
  const byDay = new Map();
  for (const w of workingHours) {
    if (!byDay.has(w.dayOfWeek)) byDay.set(w.dayOfWeek, []);
    byDay.get(w.dayOfWeek).push(`${minutesToClock(w.startMinute)}–${minutesToClock(w.endMinute)}`);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, windows]) => `${DAY_NAMES[day].slice(0, 3)} ${windows.join(', ')}`)
    .join(' · ');
};

export default function DoctorSearch() {
  const [doctors, setDoctors] = useState(null);
  const [specialisations, setSpecialisations] = useState([]);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    api.specialisations().then((r) => setSpecialisations(r.specialisations)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDoctors(null);
    const timer = setTimeout(() => {
      api
        .doctors({ specialisation: filter, q: query })
        .then((r) => !cancelled && setDoctors(r.doctors))
        .catch((err) => !cancelled && setError(err));
    }, query ? 300 : 0); // debounce typing, but filter changes apply immediately
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filter, query]);

  return (
    <main className="page">
      <div className="page-head">
        <p className="eyebrow">Find care</p>
        <h1>Choose a doctor</h1>
        <p>Pick a specialisation, then a time. You will describe your symptoms before confirming.</p>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row">
          <label className="field" style={{ flex: '1 1 220px', marginBottom: 0 }}>
            <span>Search</span>
            <input
              type="search"
              placeholder="Name or specialisation"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label className="field" style={{ flex: '0 1 240px', marginBottom: 0 }}>
            <span>Specialisation</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All specialisations</option>
              {specialisations.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({s.doctorCount})
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {doctors === null ? (
        <Loading rows={3} />
      ) : doctors.length === 0 ? (
        <Empty title="No doctors match that search">
          Try a different specialisation, or clear the search box.
        </Empty>
      ) : (
        <div className="grid grid-2">
          {doctors.map((d) => (
            <div className="card" key={d.id}>
              <div className="card-title">
                <div>
                  <h2>Dr {d.fullName}</h2>
                  <p className="muted small tight">{d.qualification || d.specialisation}</p>
                </div>
                <Badge tone="teal">{d.specialisation}</Badge>
              </div>
              {d.bio && <p className="small" style={{ marginTop: 0 }}>{d.bio}</p>}
              <dl className="kv" style={{ marginBottom: 16 }}>
                <dt>Clinic hours</dt>
                <dd className="small mono">{scheduleSummary(d.workingHours)}</dd>
                <dt>Slot length</dt>
                <dd className="mono">{d.slotDurationMinutes} min</dd>
                <dt>Fee</dt>
                <dd className="mono">{d.consultationFee ? `₹${d.consultationFee}` : 'Free'}</dd>
              </dl>
              <Link className="btn" to={`/doctors/${d.id}`}>
                See available times
              </Link>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
