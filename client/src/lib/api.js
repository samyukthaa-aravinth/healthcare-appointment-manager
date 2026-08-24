const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

const TOKEN_KEY = 'hcm.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    signal,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 204) return null;

  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const err = payload?.error || {};
    // An expired token should drop the session rather than loop on 401s.
    if (res.status === 401 && getToken()) setToken(null);
    throw new ApiError(res.status, err.code || 'ERROR', err.message || `Request failed (${res.status})`, err.details);
  }
  return payload;
}

export const api = {
  // auth
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  register: (body) => request('/auth/register', { method: 'POST', body }),
  me: () => request('/auth/me'),

  // directory
  specialisations: () => request('/doctors/specialisations'),
  doctors: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request(`/doctors${q ? `?${q}` : ''}`);
  },
  doctor: (id) => request(`/doctors/${id}`),
  availability: (id, date) => request(`/doctors/${id}/availability?date=${date}`),
  availabilityRange: (id, from, days = 7) => request(`/doctors/${id}/availability-range?from=${from}&days=${days}`),

  // booking
  hold: (body) => request('/appointments/hold', { method: 'POST', body }),
  confirm: (id, body) => request(`/appointments/${id}/confirm`, { method: 'POST', body }),
  appointments: (scope = 'upcoming') => request(`/appointments?scope=${scope}`),
  appointment: (id) => request(`/appointments/${id}`),
  cancel: (id, reason) => request(`/appointments/${id}/cancel`, { method: 'POST', body: { reason } }),
  reschedule: (id, startsAt) => request(`/appointments/${id}/reschedule`, { method: 'POST', body: { startsAt } }),
  retryTriage: (id) => request(`/appointments/${id}/retry-triage`, { method: 'POST' }),

  // doctor portal
  mySchedule: () => request('/doctors/me/schedule'),
  leavePreview: (doctorId, date) => request(`/doctors/${doctorId}/leave/preview?date=${date}`),
  markLeave: (doctorId, body) => request(`/doctors/${doctorId}/leave`, { method: 'POST', body }),
  removeLeave: (doctorId, date) => request(`/doctors/${doctorId}/leave/${date}`, { method: 'DELETE' }),
  submitVisitNote: (appointmentId, body) =>
    request(`/doctors/appointments/${appointmentId}/visit-note`, { method: 'POST', body }),

  // admin
  adminDoctors: () => request('/admin/doctors'),
  createDoctor: (body) => request('/admin/doctors', { method: 'POST', body }),
  updateDoctor: (id, body) => request(`/admin/doctors/${id}`, { method: 'PATCH', body }),
  deactivateDoctor: (id) => request(`/admin/doctors/${id}`, { method: 'DELETE' }),
  overview: () => request('/admin/overview'),
  notifications: (status) => request(`/admin/notifications${status ? `?status=${status}` : ''}`),
  flushNotifications: () => request('/admin/notifications/flush', { method: 'POST' }),
  retryNotification: (id) => request(`/admin/notifications/${id}/retry`, { method: 'POST' }),

  // calendar
  calendarStatus: () => request('/calendar/status'),
  calendarConnect: () => request('/calendar/google/connect'),
  calendarDisconnect: () => request('/calendar/google/disconnect', { method: 'POST' }),
  calendarSync: (appointmentId) => request(`/calendar/appointments/${appointmentId}/sync`, { method: 'POST' })
};
