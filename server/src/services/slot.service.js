import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parseDateOnly, toDateOnlyString, zonedDayMinutesToUtc, zonedDayOfWeek, addDays } from '../utils/time.js';

/**
 * Slots are never stored — they are derived on read from
 *   working hours  −  leave days  −  live slot locks  −  past times.
 *
 * Storing a row per slot would mean generating thousands of rows per doctor and
 * keeping them in sync every time working hours change. Deriving them keeps the
 * schema small; the SlotLock table is the only thing that has to be durable,
 * because it is what makes booking safe under concurrency.
 */

export const getDoctorOrThrow = async (doctorId) => {
  const doctor = await prisma.doctorProfile.findUnique({
    where: { id: doctorId },
    include: {
      user: { select: { id: true, fullName: true, email: true, isActive: true } },
      workingHours: { orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] }
    }
  });
  if (!doctor || !doctor.user.isActive) throw notFound('That doctor is not available.');
  return doctor;
};

/** All slot start instants a doctor's schedule defines for one calendar date. */
export const enumerateSlots = (doctor, dateOnly) => {
  const dow = zonedDayOfWeek(dateOnly, doctor.timezone);
  const windows = doctor.workingHours.filter((w) => w.dayOfWeek === dow);
  const step = doctor.slotDurationMinutes + doctor.bufferMinutes;
  if (step <= 0) return [];

  const slots = [];
  for (const w of windows) {
    for (let m = w.startMinute; m + doctor.slotDurationMinutes <= w.endMinute; m += step) {
      slots.push({
        startsAt: zonedDayMinutesToUtc(dateOnly, m, doctor.timezone),
        endsAt: zonedDayMinutesToUtc(dateOnly, m + doctor.slotDurationMinutes, doctor.timezone),
        minuteOfDay: m
      });
    }
  }
  return slots.sort((a, b) => a.startsAt - b.startsAt);
};

/**
 * @returns {Promise<{date: string, onLeave: boolean, leaveReason: string|null, slots: Array}>}
 * Each slot: { startsAt, endsAt, status: 'AVAILABLE'|'HELD'|'BOOKED'|'PAST' }
 */
export const getAvailability = async (doctorId, dateString) => {
  const dateOnly = parseDateOnly(dateString);
  if (!dateOnly) throw badRequest('Use a date in YYYY-MM-DD format.');

  const doctor = await getDoctorOrThrow(doctorId);

  const horizon = addDays(new Date(), env.bookingHorizonDays);
  if (dateOnly > horizon) {
    return { date: dateString, onLeave: false, leaveReason: null, beyondHorizon: true, slots: [] };
  }

  const [leave, locks] = await Promise.all([
    prisma.doctorLeave.findUnique({ where: { doctorId_date: { doctorId, date: dateOnly } } }),
    prisma.slotLock.findMany({
      where: {
        doctorId,
        // Widened by a day either side: a slot grid expressed in the doctor's
        // local time can straddle the UTC date boundary.
        startsAt: { gte: addDays(dateOnly, -1), lt: addDays(dateOnly, 2) }
      },
      include: { appointment: { select: { id: true, status: true } } }
    })
  ]);

  if (leave) {
    return { date: dateString, onLeave: true, leaveReason: leave.reason, slots: [] };
  }

  const now = new Date();
  const lockByTime = new Map();
  for (const lock of locks) {
    // An expired hold with no confirmed appointment no longer blocks anyone.
    const isLiveHold = lock.expiresAt > now;
    const isBooked = lock.appointment && ['HELD', 'CONFIRMED'].includes(lock.appointment.status);
    if (!isLiveHold && !isBooked) continue;
    lockByTime.set(lock.startsAt.toISOString(), lock.appointment?.status === 'CONFIRMED' ? 'BOOKED' : 'HELD');
  }

  const slots = enumerateSlots(doctor, dateOnly).map((s) => {
    const key = s.startsAt.toISOString();
    let status = lockByTime.get(key) || 'AVAILABLE';
    if (status === 'AVAILABLE' && s.startsAt <= now) status = 'PAST';
    return { startsAt: s.startsAt, endsAt: s.endsAt, status };
  });

  return { date: dateString, onLeave: false, leaveReason: null, slots };
};

/** Availability across a range — used for the "next open slot" chips. */
export const getAvailabilityRange = async (doctorId, fromDateString, days = 7) => {
  const from = parseDateOnly(fromDateString) || parseDateOnly(toDateOnlyString(new Date()));
  const out = [];
  for (let i = 0; i < Math.min(days, 30); i += 1) {
    const d = toDateOnlyString(addDays(from, i));
    // eslint-disable-next-line no-await-in-loop
    const day = await getAvailability(doctorId, d);
    out.push({
      date: d,
      onLeave: day.onLeave,
      openCount: day.slots.filter((s) => s.status === 'AVAILABLE').length
    });
  }
  return out;
};

/** Validates that a requested instant is a real, bookable slot for this doctor. */
export const assertSlotIsBookable = async (doctor, startsAt) => {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) throw badRequest('That start time is not a valid date.');
  if (start <= new Date()) throw badRequest('That slot is in the past.');
  if (start > addDays(new Date(), env.bookingHorizonDays)) {
    throw badRequest(`Bookings open ${env.bookingHorizonDays} days ahead.`);
  }

  const dateOnly = parseDateOnly(toDateOnlyString(start));
  const leave = await prisma.doctorLeave.findUnique({
    where: { doctorId_date: { doctorId: doctor.id, date: dateOnly } }
  });
  if (leave) throw badRequest('The doctor is on leave that day. Pick another date.');

  // Slot grids can straddle a date boundary in the doctor's timezone, so check
  // the day before and after too.
  const candidates = [
    ...enumerateSlots(doctor, addDays(dateOnly, -1)),
    ...enumerateSlots(doctor, dateOnly),
    ...enumerateSlots(doctor, addDays(dateOnly, 1))
  ];
  const match = candidates.find((s) => s.startsAt.getTime() === start.getTime());
  if (!match) throw badRequest("That time is not one of the doctor's slots.");
  return match;
};
