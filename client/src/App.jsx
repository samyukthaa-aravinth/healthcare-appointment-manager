import { Routes, Route, Navigate, NavLink, Link, useLocation } from 'react-router-dom';
import { useAuth, homeFor } from './lib/auth.jsx';
import { Loading } from './components/ui.jsx';

import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import DoctorSearch from './pages/DoctorSearch.jsx';
import BookAppointment from './pages/BookAppointment.jsx';
import MyAppointments from './pages/MyAppointments.jsx';
import AppointmentDetail from './pages/AppointmentDetail.jsx';
import DoctorDashboard from './pages/DoctorDashboard.jsx';
import DoctorAppointment from './pages/DoctorAppointment.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import Settings from './pages/Settings.jsx';

function Protected({ roles, children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="page"><Loading /></div>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user)} replace />;
  return children;
}

function TopBar() {
  const { user, logout } = useAuth();
  if (!user) return null;

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link to={homeFor(user)} className="brand">
          Meridian<span>.</span>
        </Link>
        <nav className="nav">
          {user.role === 'PATIENT' && (
            <>
              <NavLink to="/doctors">Find a doctor</NavLink>
              <NavLink to="/appointments">My appointments</NavLink>
            </>
          )}
          {user.role === 'DOCTOR' && <NavLink to="/doctor">My schedule</NavLink>}
          {user.role === 'ADMIN' && (
            <>
              <NavLink to="/admin">Clinic</NavLink>
              <NavLink to="/doctors">Directory</NavLink>
            </>
          )}
          <NavLink to="/settings">Settings</NavLink>
          <span className="role-chip">{user.role}</span>
          <button type="button" onClick={logout}>
            Sign out
          </button>
        </nav>
      </div>
    </header>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <div className="app">
      <TopBar />
      <Routes>
        <Route path="/login" element={user ? <Navigate to={homeFor(user)} replace /> : <Login />} />
        <Route path="/register" element={user ? <Navigate to={homeFor(user)} replace /> : <Register />} />

        <Route path="/doctors" element={<Protected><DoctorSearch /></Protected>} />
        <Route path="/doctors/:doctorId" element={<Protected roles={['PATIENT', 'ADMIN']}><BookAppointment /></Protected>} />
        <Route path="/appointments" element={<Protected roles={['PATIENT', 'ADMIN']}><MyAppointments /></Protected>} />
        <Route path="/appointments/:appointmentId" element={<Protected><AppointmentDetail /></Protected>} />

        <Route path="/doctor" element={<Protected roles={['DOCTOR']}><DoctorDashboard /></Protected>} />
        <Route path="/doctor/appointments/:appointmentId" element={<Protected roles={['DOCTOR', 'ADMIN']}><DoctorAppointment /></Protected>} />

        <Route path="/admin" element={<Protected roles={['ADMIN']}><AdminDashboard /></Protected>} />
        <Route path="/settings" element={<Protected><Settings /></Protected>} />

        <Route
          path="/"
          element={loading ? <div className="page"><Loading rows={2} /></div> : <Navigate to={user ? homeFor(user) : '/login'} replace />}
        />
        <Route
          path="*"
          element={
            <div className="page page-narrow">
              <h1>Page not found</h1>
              <p className="muted">That link does not lead anywhere. Head back to your dashboard.</p>
              <Link className="btn" to="/">Go to dashboard</Link>
            </div>
          }
        />
      </Routes>
    </div>
  );
}
