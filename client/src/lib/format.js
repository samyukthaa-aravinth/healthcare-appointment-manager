const opts = { timeZone: undefined };

export const timeOf = (iso, tz) =>
  new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz || opts.timeZone
  });

export const dateOf = (iso, tz) =>
  new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: tz || opts.timeZone
  });

export const longWhen = (iso, tz) =>
  new Date(iso).toLocaleString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz || opts.timeZone
  });

/** YYYY-MM-DD in the browser's local zone (not UTC — avoids off-by-one dates). */
export const toDateInput = (d = new Date()) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + n);
  return toDateInput(d);
};

export const relative = (iso) => {
  const diff = new Date(iso) - Date.now();
  const mins = Math.round(diff / 60000);
  if (Math.abs(mins) < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (Math.abs(hrs) < 36) return `in ${hrs} h`;
  return `in ${Math.round(hrs / 24)} days`;
};

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const minutesToClock = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export const clockToMinutes = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + (m || 0);
};
