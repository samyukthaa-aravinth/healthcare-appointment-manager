import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Alert, ErrorNote, Loading, Badge } from '../components/ui.jsx';

export default function Settings() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const calendarResult = params.get('calendar');
  const calendarMessage = params.get('message');

  const load = () => api.calendarStatus().then(setStatus).catch(setError);
  useEffect(load, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.calendarConnect();
      window.location.href = url;
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.calendarDisconnect();
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page page-narrow">
      <div className="page-head">
        <p className="eyebrow">Your account</p>
        <h1>Settings</h1>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      {calendarResult === 'connected' && (
        <Alert kind="ok" title="Calendar connected" onDismiss={() => setParams({})}>
          New appointments will appear in your Google Calendar automatically.
        </Alert>
      )}
      {calendarResult === 'error' && (
        <Alert kind="error" title="Could not connect your calendar" onDismiss={() => setParams({})}>
          {calendarMessage || 'Google did not complete the authorisation. Try again.'}
        </Alert>
      )}

      <div className="card">
        <div className="card-title">
          <h2>Profile</h2>
          <Badge tone="teal">{user?.role}</Badge>
        </div>
        <dl className="kv">
          <dt>Name</dt>
          <dd>{user?.fullName}</dd>
          <dt>Email</dt>
          <dd>{user?.email}</dd>
          {user?.phone && (
            <>
              <dt>Phone</dt>
              <dd>{user.phone}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Google Calendar</h2>
          {status && (
            <Badge tone={status.connected ? 'LOW' : 'neutral'}>
              {status.connected ? 'Connected' : 'Not connected'}
            </Badge>
          )}
        </div>

        {status === null ? (
          <Loading rows={1} />
        ) : !status.configured ? (
          <Alert kind="info">
            Calendar sync is not set up on this server. An administrator needs to add Google OAuth credentials
            to the environment before it can be used.
          </Alert>
        ) : status.connected ? (
          <>
            <p className="small">
              Appointments are added to your calendar when booked, moved when rescheduled, and removed when
              cancelled.
            </p>
            <button className="btn ghost" onClick={disconnect} disabled={busy}>
              {busy ? 'Disconnecting…' : 'Disconnect calendar'}
            </button>
          </>
        ) : (
          <>
            <p className="small">
              Connect your calendar and every appointment shows up there automatically, with a reminder an hour
              before.
            </p>
            <button className="btn" onClick={connect} disabled={busy}>
              {busy ? 'Redirecting…' : 'Connect Google Calendar'}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
