import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { Field, ErrorNote } from '../components/ui.jsx';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        password: form.password,
        ...(form.phone ? { phone: form.phone.trim() } : {})
      });
      navigate('/doctors', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <p className="auth-mark">
          Meridian<span>.</span> Clinic
        </p>
        <div className="card">
          <h1 style={{ marginBottom: 4 }}>Create your account</h1>
          <p className="muted small" style={{ marginTop: 0, marginBottom: 18 }}>
            Takes a minute. You will need it to book and to read your visit summaries.
          </p>
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          <form onSubmit={submit}>
            <Field label="Full name" required value={form.fullName} onChange={set('fullName')} />
            <Field label="Email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
            <Field label="Phone" hint="optional" value={form.phone} onChange={set('phone')} />
            <Field
              label="Password"
              hint="at least 8 characters"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={form.password}
              onChange={set('password')}
            />
            <button className="btn block" disabled={busy}>
              {busy ? 'Creating account…' : 'Create account'}
            </button>
          </form>
          <p className="small muted" style={{ marginBottom: 0, marginTop: 16 }}>
            Already registered? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
