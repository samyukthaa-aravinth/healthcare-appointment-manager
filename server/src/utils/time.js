import { formatInTimeZone, toZonedTime, fromZonedTime } from 'date-fns-tz';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-09-01" -> Date at UTC midnight (matches Prisma @db.Date storage). */
export const parseDateOnly = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
};

export const toDateOnlyString = (date) => new Date(date).toISOString().slice(0, 10);

/** Local wall-clock day + minutes-from-midnight, in a timezone, as a UTC instant. */
export const zonedDayMinutesToUtc = (dateOnly, minutes, timeZone) => {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return fromZonedTime(`${toDateOnlyString(dateOnly)} ${hh}:${mm}:00`, timeZone);
};

/** 0 = Sunday, in the doctor's timezone. */
export const zonedDayOfWeek = (dateOnly, timeZone) =>
  Number(formatInTimeZone(zonedDayMinutesToUtc(dateOnly, 12 * 60, timeZone), timeZone, 'i')) % 7;

export const formatSlot = (date, timeZone = 'Asia/Kolkata') =>
  formatInTimeZone(date, timeZone, "EEE d MMM yyyy, h:mm a");

export const formatDateHuman = (date, timeZone = 'Asia/Kolkata') =>
  formatInTimeZone(date, timeZone, 'EEEE d MMMM yyyy');

export const zonedNow = (timeZone) => toZonedTime(new Date(), timeZone);

export const addMinutes = (date, minutes) => new Date(new Date(date).getTime() + minutes * 60000);
export const addHours = (date, hours) => addMinutes(date, hours * 60);
export const addDays = (date, days) => new Date(new Date(date).getTime() + days * DAY_MS);
