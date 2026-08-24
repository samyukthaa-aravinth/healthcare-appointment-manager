import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth, homeFor } from '../lib/auth.jsx';
import { Field, ErrorNote } from '../components/ui.jsx';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(form.email.trim(), form.password);
      navigate(location.state?.from || homeFor(user), { replace: true });
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
          <h1 style={{ marginBottom: 4 }}>Sign in</h1>
          <p className="muted small" style={{ marginTop: 0, marginBottom: 18 }}>
            Patients, doctors and clinic staff all sign in here.
          </p>
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          <form onSubmit={submit}>
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <Field
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <button className="btn block" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <p className="small muted" style={{ marginBottom: 0, marginTop: 16 }}>
            New patient? <Link to="/register">Create an account</Link>
          </p>
          <div className="demo-creds">
            Demo logins after seeding:
            <br />
            patient · rahul@example.com / Password@123
            <br />
            doctor · ananya.rao@meridian.health / Password@123
            <br />
            admin · admin@meridian.health / Admin@12345
          </div>
        </div>
      </div>
    </div>
  );
}
