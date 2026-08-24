import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { AppointmentCard, Loading, Empty, ErrorNote } from '../components/ui.jsx';

export default function MyAppointments() {
  const [scope, setScope] = useState('upcoming');
  const [appointments, setAppointments] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setAppointments(null);
    api
      .appointments(scope)
      .then((r) => !cancelled && setAppointments(r.appointments))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [scope]);

  return (
    <main className="page">
      <div className="page-head">
        <p className="eyebrow">Your care</p>
        <div className="spread">
          <h1>Appointments</h1>
          <div className="row">
            <button
              className={`btn ${scope === 'upcoming' ? '' : 'ghost'} small`}
              onClick={() => setScope('upcoming')}
            >
              Upcoming
            </button>
            <button className={`btn ${scope === 'past' ? '' : 'ghost'} small`} onClick={() => setScope('past')}>
              Past
            </button>
          </div>
        </div>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      {appointments === null ? (
        <Loading />
      ) : appointments.length === 0 ? (
        <Empty
          title={scope === 'upcoming' ? 'Nothing booked yet' : 'No past visits'}
          action={
            scope === 'upcoming' && (
              <Link className="btn" to="/doctors">
                Find a doctor
              </Link>
            )
          }
        >
          {scope === 'upcoming'
            ? 'Book a slot and your appointments will show up here.'
            : 'Summaries of completed visits will appear here.'}
        </Empty>
      ) : (
        <div className="stack">
          {appointments.map((a) => (
            <AppointmentCard key={a.id} appointment={a} to={`/appointments/${a.id}`} perspective="PATIENT" />
          ))}
        </div>
      )}
    </main>
  );
}
