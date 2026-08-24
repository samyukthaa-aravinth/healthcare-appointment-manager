import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { conflict, notFound, badRequest, forbidden } from '../lib/errors.js';
import { addMinutes, addDays, formatSlot, formatDateHuman, parseDateOnly, toDateOnlyString } from '../utils/time.js';
import { getDoctorOrThrow, assertSlotIsBookable, getAvailability } from './slot.service.js';
import { enqueueEmail } from './notification.service.js';
import { generatePreVisitSummary } from './llm.service.js';
import * as calendar from './calendar.service.js';

const FAR_FUTURE = new Date('2999-12-31T00:00:00.000Z');

const appointmentInclude = {
  patient: { select: { id: true, fullName: true, email: true, phone: true } },
  doctor: {
    include: { user: { select: { id: true, fullName: true, email: true } } }
  },
  symptomReport: true,
  visitNote: true
};

export const serialiseAppointment = (a) => ({
  id: a.id,
  status: a.status,
  startsAt: a.startsAt,
  endsAt: a.endsAt,
  holdExpiresAt: a.holdExpiresAt,
  reasonText: a.reasonText,
  cancelledBy: a.cancelledBy,
  cancelReason: a.cancelReason,
  createdAt: a.createdAt,
  patient: a.patient
    ? { id: a.patient.id, fullName: a.patient.fullName, email: a.patient.email, phone: a.patient.phone }
    : undefined,
  doctor: a.doctor
    ? {
        id: a.doctor.id,
        fullName: a.doctor.user.fullName,
        email: a.doctor.user.email,
        specialisation: a.doctor.specialisation,
        timezone: a.doctor.timezone
      }
    : undefined,
  slotLabel: a.doctor ? formatSlot(a.startsAt, a.doctor.timezone) : formatSlot(a.startsAt),
  symptomReport: a.symptomReport || null,
  visitNote: a.visitNote || null
});

/* ------------------------------------------------------------------ */
/* 1. Hold a slot                                                      */
/* ------------------------------------------------------------------ */

/**
 * Step one of booking. Creating the SlotLock row is the moment the slot becomes
 * this patient's — the unique index on (doctorId, startsAt) means two
 * simultaneous requests cannot both succeed. The loser gets a clean 409 rather
 * than a corrupted schedule.
 *
 * The hold expires (default 10 min) so an abandoned symptom form does not park
 * a slot forever.
 */
export const holdSlot = async ({ patientId, doctorId, startsAt, reasonText }) => {
  const doctor = await getDoctorOrThrow(doctorId);
  const slot = await assertSlotIsBookable(doctor, startsAt);
  const start = slot.startsAt;
  const expiresAt = addMinutes(new Date(), env.slotHoldMinutes);

  const clash = await prisma.appointment.findFirst({
    where: { patientId, startsAt: start, status: { in: ['HELD', 'CONFIRMED'] } }
  });
  if (clash) throw conflict('You already have a booking at this time.', 'PATIENT_DOUBLE_BOOKING');

  try {
    return await prisma.$transaction(async (tx) => {
      // Clear a dead hold on this exact slot first, inside the transaction, so
      // the delete + insert are atomic with respect to other bookers.
      await tx.slotLock.deleteMany({
        where: { doctorId, startsAt: start, expiresAt: { lt: new Date() }, appointment: { is: null } }
      });

      const lock = await tx.slotLock.create({ data: { doctorId, startsAt: start, expiresAt } });

      const appointment = await tx.appointment.create({
        data: {
          patientId,
          doctorId,
          slotLockId: lock.id,
          startsAt: start,
          endsAt: slot.endsAt,
          status: 'HELD',
          holdExpiresAt: expiresAt,
          reasonText: reasonText || null
        },
        include: appointmentInclude
      });

      return serialiseAppointment(appointment);
    });
  } catch (err) {
    if (err.code === 'P2002') {
      throw conflict('Someone just took that slot. Pick another time.', 'SLOT_TAKEN', {
        startsAt: start
      });
    }
    throw err;
  }
};

/* ------------------------------------------------------------------ */
/* 2. Confirm with the symptom form                                    */
/* ------------------------------------------------------------------ */

/**
 * Step two. Saves the symptom form, promotes HELD -> CONFIRMED, then does the
 * slow work (LLM triage, calendar, email) after the transaction commits so a
 * third-party outage can never roll back a confirmed booking.
 */
export const confirmAppointment = async ({ appointmentId, patientId, form }) => {
  const existing = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: appointmentInclude
  });
  if (!existing) throw notFound('Appointment not found.');
  if (existing.patientId !== patientId) throw forbidden();
  if (existing.status === 'CONFIRMED') throw badRequest('This appointment is already confirmed.');
  if (existing.status !== 'HELD') throw badRequest(`This appointment is ${existing.status.toLowerCase()}.`);
  if (existing.holdExpiresAt && existing.holdExpiresAt < new Date()) {
    throw conflict('Your hold on this slot expired. Please pick the slot again.', 'HOLD_EXPIRED');
  }

  const appointment = await prisma.$transaction(async (tx) => {
    await tx.symptomReport.upsert({
      where: { appointmentId },
      create: { appointmentId, ...form, llmStatus: 'PENDING' },
      update: { ...form, llmStatus: 'PENDING' }
    });

    // The lock stops being a short-lived hold and becomes a durable booking.
    if (existing.slotLockId) {
      await tx.slotLock.update({ where: { id: existing.slotLockId }, data: { expiresAt: FAR_FUTURE } });
    }

    return tx.appointment.update({
      where: { id: appointmentId },
      data: { status: 'CONFIRMED', holdExpiresAt: null },
      include: appointmentInclude
    });
  });

  // --- post-commit side effects, each isolated ---
  const triage = await runPreVisitTriage(appointmentId).catch((err) => {
    logger.error('Pre-visit triage crashed', err);
    return null;
  });

  await enqueueEmail({
    dedupeKey: `booking:patient:${appointment.id}`,
    template: 'BOOKING_CONFIRMATION_PATIENT',
    toEmail: appointment.patient.email,
    toName: appointment.patient.fullName,
    payload: {
      appointmentId: appointment.id,
      patientName: appointment.patient.fullName,
      doctorName: appointment.doctor.user.fullName,
      specialisation: appointment.doctor.specialisation,
      slotLabel: formatSlot(appointment.startsAt, appointment.doctor.timezone)
    }
  });

  await enqueueEmail({
    dedupeKey: `booking:doctor:${appointment.id}`,
    template: 'BOOKING_CONFIRMATION_DOCTOR',
    toEmail: appointment.doctor.user.email,
    toName: appointment.doctor.user.fullName,
    payload: {
      appointmentId: appointment.id,
      patientName: appointment.patient.fullName,
      slotLabel: formatSlot(appointment.startsAt, appointment.doctor.timezone),
      urgency: triage?.urgency,
      chiefComplaint: triage?.chiefComplaint
    }
  });

  await calendar.syncAppointment(appointment.id).catch((err) =>
    logger.warn('Calendar sync deferred', { appointmentId: appointment.id, error: err.message })
  );

  const fresh = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: appointmentInclude });
  return serialiseAppointment(fresh);
};

/** Runs the LLM triage and writes it back. Never throws. */
export const runPreVisitTriage = async (appointmentId) => {
  const report = await prisma.symptomReport.findUnique({ where: { appointmentId } });
  if (!report) return null;

  const result = await generatePreVisitSummary(report);
  const updated = await prisma.symptomReport.update({
    where: { appointmentId },
    data: {
      urgency: result.data.urgency,
      chiefComplaint: result.data.chiefComplaint,
      suggestedQuestions: {
        questions: result.data.suggestedQuestions,
        keyPoints: result.data.keyPoints || []
      },
      llmStatus: result.status === 'OK' ? 'OK' : 'FALLBACK',
      llmModel: result.model || null,
      llmError: result.error || null,
      generatedAt: new Date()
    }
  });
  return updated;
};

/* ------------------------------------------------------------------ */
/* 3. Cancel                                                           */
/* ------------------------------------------------------------------ */

export const cancelAppointment = async ({ appointmentId, actor, cancelledBy, reason }) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: appointmentInclude
  });
  if (!appointment) throw notFound('Appointment not found.');

  if (actor) {
    const isPatient = appointment.patientId === actor.id;
    const isDoctor = appointment.doctor.userId === actor.id;
    if (!isPatient && !isDoctor && actor.role !== 'ADMIN') throw forbidden();
  }
  if (['CANCELLED', 'COMPLETED'].includes(appointment.status)) {
    throw badRequest(`This appointment is already ${appointment.status.toLowerCase()}.`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.appointment.update({
      where: { id: appointmentId },
      data: {
        status: 'CANCELLED',
        cancelledBy,
        cancelReason: reason || null,
        cancelledAt: new Date(),
        slotLockId: null
      }
    });
    // Releasing the lock is what puts the slot back on the grid.
    if (appointment.slotLockId) await tx.slotLock.delete({ where: { id: appointment.slotLockId } }).catch(() => {});
    await tx.medicationReminder.updateMany({
      where: { appointmentId, status: 'SCHEDULED' },
      data: { status: 'CANCELLED' }
    });
  });

  const payload = {
    appointmentId,
    doctorName: appointment.doctor.user.fullName,
    slotLabel: formatSlot(appointment.startsAt, appointment.doctor.timezone),
    cancelledBy,
    cancelReason: reason
  };

  await enqueueEmail({
    dedupeKey: `cancel:patient:${appointmentId}`,
    template: 'APPOINTMENT_CANCELLED',
    toEmail: appointment.patient.email,
    toName: appointment.patient.fullName,
    payload
  });
  await enqueueEmail({
    dedupeKey: `cancel:doctor:${appointmentId}`,
    template: 'APPOINTMENT_CANCELLED',
    toEmail: appointment.doctor.user.email,
    toName: appointment.doctor.user.fullName,
    payload: { ...payload, doctorName: appointment.doctor.user.fullName }
  });

  await calendar.removeAppointmentEvents(appointmentId).catch((err) =>
    logger.warn('Calendar delete deferred', { appointmentId, error: err.message })
  );

  return { id: appointmentId, status: 'CANCELLED' };
};

/* ------------------------------------------------------------------ */
/* 4. Reschedule                                                       */
/* ------------------------------------------------------------------ */

/** Books the new slot first; only releases the old one once the new lock is won. */
export const rescheduleAppointment = async ({ appointmentId, actor, newStartsAt }) => {
  const existing = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: appointmentInclude
  });
  if (!existing) throw notFound('Appointment not found.');
  if (actor && existing.patientId !== actor.id && actor.role !== 'ADMIN' && existing.doctor.userId !== actor.id) {
    throw forbidden();
  }
  if (!['HELD', 'CONFIRMED'].includes(existing.status)) {
    throw badRequest('Only upcoming appointments can be rescheduled.');
  }

  const doctor = await getDoctorOrThrow(existing.doctorId);
  const slot = await assertSlotIsBookable(doctor, newStartsAt);

  const updated = await prisma
    .$transaction(async (tx) => {
      await tx.slotLock.deleteMany({
        where: {
          doctorId: doctor.id,
          startsAt: slot.startsAt,
          expiresAt: { lt: new Date() },
          appointment: { is: null }
        }
      });
      const lock = await tx.slotLock.create({
        data: { doctorId: doctor.id, startsAt: slot.startsAt, expiresAt: FAR_FUTURE }
      });
      const oldLockId = existing.slotLockId;
      const appt = await tx.appointment.update({
        where: { id: appointmentId },
        data: { slotLockId: lock.id, startsAt: slot.startsAt, endsAt: slot.endsAt },
        include: appointmentInclude
      });
      if (oldLockId) await tx.slotLock.delete({ where: { id: oldLockId } }).catch(() => {});
      return appt;
    })
    .catch((err) => {
      if (err.code === 'P2002') throw conflict('That slot was just taken. Pick another time.', 'SLOT_TAKEN');
      throw err;
    });

  await enqueueEmail({
    dedupeKey: `reschedule:patient:${appointmentId}:${slot.startsAt.toISOString()}`,
    template: 'BOOKING_CONFIRMATION_PATIENT',
    toEmail: updated.patient.email,
    toName: updated.patient.fullName,
    payload: {
      appointmentId,
      patientName: updated.patient.fullName,
      doctorName: updated.doctor.user.fullName,
      specialisation: updated.doctor.specialisation,
      slotLabel: formatSlot(updated.startsAt, updated.doctor.timezone)
    }
  });

  await calendar.syncAppointment(appointmentId).catch((err) =>
    logger.warn('Calendar update deferred', { appointmentId, error: err.message })
  );

  return serialiseAppointment(updated);
};

/* ------------------------------------------------------------------ */
/* 5. Doctor leave with existing bookings                              */
/* ------------------------------------------------------------------ */

/**
 * Marking leave is never silently destructive.
 *
 * `dryRun` returns the list of affected patients so the admin/doctor sees the
 * damage before committing. On commit, every affected appointment is cancelled
 * as CANCELLED-by-DOCTOR, the slot locks are released, calendar events are
 * removed, and each patient gets an email that includes the doctor's next open
 * slots so rebooking is one click rather than a search.
 */
export const previewLeaveImpact = async (doctorId, dateString) => {
  const date = parseDateOnly(dateString);
  if (!date) throw badRequest('Use a date in YYYY-MM-DD format.');

  const doctor = await getDoctorOrThrow(doctorId);
  const dayStart = new Date(date);
  const dayEnd = addDays(dayStart, 1);

  const affected = await prisma.appointment.findMany({
    where: {
      doctorId,
      status: { in: ['HELD', 'CONFIRMED'] },
      startsAt: { gte: addMinutes(dayStart, -720), lt: addMinutes(dayEnd, 720) }
    },
    include: appointmentInclude,
    orderBy: { startsAt: 'asc' }
  });

  // Only the ones that actually land on this date in the doctor's timezone.
  const onDate = affected.filter((a) => toDateOnlyString(a.startsAt) === dateString);

  return {
    doctorId,
    doctorName: doctor.user.fullName,
    date: dateString,
    affectedCount: onDate.length,
    appointments: onDate.map(serialiseAppointment)
  };
};

const nextOpenSlots = async (doctorId, fromDateString, wanted = 3) => {
  const out = [];
  const from = parseDateOnly(fromDateString);
  for (let i = 1; i <= 10 && out.length < wanted; i += 1) {
    const dateStr = toDateOnlyString(addDays(from, i));
    // eslint-disable-next-line no-await-in-loop
    const day = await getAvailability(doctorId, dateStr).catch(() => null);
    if (!day || day.onLeave) continue;
    for (const s of day.slots) {
      if (s.status === 'AVAILABLE' && out.length < wanted) out.push(s.startsAt);
    }
  }
  return out;
};

export const markLeave = async ({ doctorId, dateString, reason, confirm }) => {
  const impact = await previewLeaveImpact(doctorId, dateString);
  if (impact.affectedCount > 0 && !confirm) {
    throw conflict(
      `${impact.affectedCount} patient(s) are booked that day. Re-send with confirm=true to cancel and notify them.`,
      'LEAVE_HAS_BOOKINGS',
      impact
    );
  }

  const date = parseDateOnly(dateString);
  const doctor = await getDoctorOrThrow(doctorId);

  const leave = await prisma.doctorLeave.upsert({
    where: { doctorId_date: { doctorId, date } },
    create: { doctorId, date, reason: reason || null },
    update: { reason: reason || null }
  });

  const alternatives = impact.affectedCount ? await nextOpenSlots(doctorId, dateString) : [];
  const altLabels = alternatives.map((d) => formatSlot(d, doctor.timezone));

  for (const appt of impact.appointments) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.$transaction(async (tx) => {
      const row = await tx.appointment.findUnique({ where: { id: appt.id } });
      if (!row || !['HELD', 'CONFIRMED'].includes(row.status)) return;
      await tx.appointment.update({
        where: { id: appt.id },
        data: {
          status: 'CANCELLED',
          cancelledBy: 'DOCTOR',
          cancelReason: reason ? `Doctor on leave: ${reason}` : 'Doctor on leave',
          cancelledAt: new Date(),
          slotLockId: null
        }
      });
      if (row.slotLockId) await tx.slotLock.delete({ where: { id: row.slotLockId } }).catch(() => {});
    });

    // eslint-disable-next-line no-await-in-loop
    await enqueueEmail({
      dedupeKey: `leave:${doctorId}:${dateString}:${appt.id}`,
      template: 'DOCTOR_LEAVE_CONFLICT',
      toEmail: appt.patient.email,
      toName: appt.patient.fullName,
      payload: {
        appointmentId: appt.id,
        doctorId,
        patientName: appt.patient.fullName,
        doctorName: doctor.user.fullName,
        dateLabel: formatDateHuman(new Date(`${dateString}T12:00:00Z`), doctor.timezone),
        slotLabel: appt.slotLabel,
        reason,
        alternatives: altLabels
      }
    });

    // eslint-disable-next-line no-await-in-loop
    await calendar.removeAppointmentEvents(appt.id).catch(() => {});
  }

  logger.info('Leave recorded', { doctorId, dateString, cancelled: impact.affectedCount });
  return { leave, cancelledCount: impact.affectedCount, alternativesOffered: altLabels };
};

export const removeLeave = async (doctorId, dateString) => {
  const date = parseDateOnly(dateString);
  if (!date) throw badRequest('Use a date in YYYY-MM-DD format.');
  await prisma.doctorLeave.delete({ where: { doctorId_date: { doctorId, date } } }).catch(() => {});
  return { doctorId, date: dateString, removed: true };
};

/* ------------------------------------------------------------------ */
/* 6. Hold expiry sweep                                                */
/* ------------------------------------------------------------------ */

export const expireStaleHolds = async () => {
  const now = new Date();
  const stale = await prisma.appointment.findMany({
    where: { status: 'HELD', holdExpiresAt: { lt: now } },
    select: { id: true, slotLockId: true }
  });
  if (!stale.length) return { expired: 0 };

  for (const a of stale) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.$transaction(async (tx) => {
      await tx.appointment.update({
        where: { id: a.id },
        data: { status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: 'Hold expired before confirmation', cancelledAt: now, slotLockId: null }
      });
      if (a.slotLockId) await tx.slotLock.delete({ where: { id: a.slotLockId } }).catch(() => {});
    });
  }

  // Orphan locks (process died between lock and appointment insert).
  const orphans = await prisma.slotLock.deleteMany({
    where: { expiresAt: { lt: now }, appointment: { is: null } }
  });

  logger.info('Expired stale holds', { holds: stale.length, orphanLocks: orphans.count });
  return { expired: stale.length, orphanLocks: orphans.count };
};

export { appointmentInclude };
