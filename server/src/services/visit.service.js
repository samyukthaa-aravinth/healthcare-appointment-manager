import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { notFound, forbidden, badRequest } from '../lib/errors.js';
import { addDays, addMinutes, formatSlot } from '../utils/time.js';
import { generatePostVisitSummary } from './llm.service.js';
import { enqueueEmail } from './notification.service.js';

/**
 * Frequency shorthand -> the local clock times a dose is due.
 * "1-0-1" style and plain words both work; anything unrecognised falls back to
 * a single 09:00 reminder so the patient still gets nudged.
 */
export const FREQUENCY_TIMES = {
  ONCE_DAILY: [9 * 60],
  TWICE_DAILY: [9 * 60, 21 * 60],
  THRICE_DAILY: [8 * 60, 14 * 60, 20 * 60],
  FOUR_TIMES_DAILY: [8 * 60, 12 * 60, 16 * 60, 20 * 60],
  EVERY_OTHER_DAY: [9 * 60],
  WEEKLY: [9 * 60],
  AS_NEEDED: []
};

export const parseFrequency = (raw) => {
  const s = String(raw || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (FREQUENCY_TIMES[s]) return s;
  const compact = String(raw || '').replace(/\s/g, '');
  if (/^1-?0-?1$/.test(compact)) return 'TWICE_DAILY';
  if (/^1-?1-?1$/.test(compact)) return 'THRICE_DAILY';
  if (/^(1-?0-?0|0-?0-?1)$/.test(compact)) return 'ONCE_DAILY';
  if (/OD|ONCE/.test(s)) return 'ONCE_DAILY';
  if (/BD|BID|TWICE/.test(s)) return 'TWICE_DAILY';
  if (/TDS|TID|THRICE|THREE/.test(s)) return 'THRICE_DAILY';
  if (/QID|FOUR/.test(s)) return 'FOUR_TIMES_DAILY';
  if (/SOS|PRN|NEEDED/.test(s)) return 'AS_NEEDED';
  if (/WEEK/.test(s)) return 'WEEKLY';
  return 'ONCE_DAILY';
};

/** Builds every reminder row for a prescription. Capped so one bad input can't flood the table. */
export const buildReminderSchedule = ({ prescriptions, from, timezone = 'Asia/Kolkata', maxPerMed = 60 }) => {
  const rows = [];
  const start = new Date(from);

  for (const med of prescriptions || []) {
    const key = parseFrequency(med.frequency);
    const times = FREQUENCY_TIMES[key];
    if (!times?.length) continue;

    const days = Math.min(Number(med.durationDays) || 5, 30);
    const stepDays = key === 'EVERY_OTHER_DAY' ? 2 : key === 'WEEKLY' ? 7 : 1;

    for (let d = 0; d < days; d += stepDays) {
      const day = addDays(start, d);
      for (const minutes of times) {
        const scheduledFor = new Date(
          Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, 0, 0)
        );
        // Local-clock minute converted through the doctor's offset at that instant.
        const localised = addMinutes(scheduledFor, minutes - tzOffsetMinutes(scheduledFor, timezone));
        if (localised <= new Date()) continue;
        if (rows.filter((r) => r.medicationName === med.name).length >= maxPerMed) break;
        rows.push({
          medicationName: med.name,
          dosage: med.dosage || null,
          instruction: med.instructions || null,
          scheduledFor: localised
        });
      }
    }
  }
  return rows.sort((a, b) => a.scheduledFor - b.scheduledFor);
};

const tzOffsetMinutes = (date, timeZone) => {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - date.getTime()) / 60000;
};

/**
 * Doctor submits notes -> row saved -> LLM rewrite -> reminders scheduled ->
 * summary emailed. Each stage is independent: if the LLM is down the patient
 * still gets the doctor's own words and the reminders still fire.
 */
export const submitVisitNote = async ({ appointmentId, actorUserId, isAdmin, payload }) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true, doctor: { include: { user: true } }, visitNote: true }
  });
  if (!appointment) throw notFound('Appointment not found.');
  if (!isAdmin && appointment.doctor.userId !== actorUserId) throw forbidden();
  if (appointment.status === 'CANCELLED') throw badRequest('This appointment was cancelled.');

  const prescriptions = (payload.prescriptions || []).map((m) => ({
    name: String(m.name).trim(),
    dosage: m.dosage || '',
    frequency: m.frequency || 'ONCE_DAILY',
    durationDays: m.durationDays ?? null,
    instructions: m.instructions || ''
  }));

  const note = await prisma.$transaction(async (tx) => {
    const saved = await tx.visitNote.upsert({
      where: { appointmentId },
      create: {
        appointmentId,
        clinicalNotes: payload.clinicalNotes,
        diagnosis: payload.diagnosis || null,
        prescriptions,
        followUpAt: payload.followUpAt ? new Date(payload.followUpAt) : null,
        followUpNotes: payload.followUpNotes || null,
        llmStatus: 'PENDING'
      },
      update: {
        clinicalNotes: payload.clinicalNotes,
        diagnosis: payload.diagnosis || null,
        prescriptions,
        followUpAt: payload.followUpAt ? new Date(payload.followUpAt) : null,
        followUpNotes: payload.followUpNotes || null,
        llmStatus: 'PENDING'
      }
    });
    await tx.appointment.update({ where: { id: appointmentId }, data: { status: 'COMPLETED' } });
    return saved;
  });

  // --- LLM rewrite (never fatal) ---
  const result = await generatePostVisitSummary({
    clinicalNotes: note.clinicalNotes,
    diagnosis: note.diagnosis,
    prescriptions,
    followUpAt: note.followUpAt,
    followUpNotes: note.followUpNotes
  });

  const updated = await prisma.visitNote.update({
    where: { appointmentId },
    data: {
      patientSummary: result.data.patientSummary,
      medicationSchedule: result.data.medicationSchedule,
      followUpSteps: result.data.followUpSteps,
      llmStatus: result.status === 'OK' ? 'OK' : 'FALLBACK',
      llmModel: result.model || null,
      llmError: result.error || null,
      generatedAt: new Date()
    }
  });

  // --- medication reminders ---
  const reminderRows = buildReminderSchedule({
    prescriptions,
    from: new Date(),
    timezone: appointment.doctor.timezone
  });
  if (reminderRows.length) {
    await prisma.medicationReminder.deleteMany({ where: { appointmentId, status: 'SCHEDULED' } });
    await prisma.medicationReminder.createMany({
      data: reminderRows.map((r) => ({ ...r, appointmentId, patientId: appointment.patientId }))
    });
  }

  await enqueueEmail({
    dedupeKey: `postvisit:${appointmentId}:${updated.updatedAt.getTime()}`,
    template: 'POST_VISIT_SUMMARY',
    toEmail: appointment.patient.email,
    toName: appointment.patient.fullName,
    payload: {
      appointmentId,
      doctorName: appointment.doctor.user.fullName,
      slotLabel: formatSlot(appointment.startsAt, appointment.doctor.timezone),
      patientSummary: updated.patientSummary,
      medicationSchedule: updated.medicationSchedule,
      followUpSteps: updated.followUpSteps
    }
  });

  logger.info('Visit note submitted', {
    appointmentId,
    llmStatus: updated.llmStatus,
    reminders: reminderRows.length
  });

  return { note: updated, remindersScheduled: reminderRows.length };
};

/** Worker pass: send every dose reminder that has come due. */
export const dispatchDueMedicationReminders = async (limit = 50) => {
  const due = await prisma.medicationReminder.findMany({
    where: { status: 'SCHEDULED', scheduledFor: { lte: new Date() } },
    include: { patient: { select: { email: true, fullName: true } } },
    take: limit,
    orderBy: { scheduledFor: 'asc' }
  });

  for (const r of due) {
    // eslint-disable-next-line no-await-in-loop
    await enqueueEmail({
      dedupeKey: `medreminder:${r.id}`,
      template: 'MEDICATION_REMINDER',
      toEmail: r.patient.email,
      toName: r.patient.fullName,
      payload: {
        patientName: r.patient.fullName,
        medicationName: r.medicationName,
        dosage: r.dosage,
        instruction: r.instruction
      }
    });
    // eslint-disable-next-line no-await-in-loop
    await prisma.medicationReminder.update({
      where: { id: r.id },
      data: { status: 'SENT', sentAt: new Date() }
    });
  }

  if (due.length) logger.info('Medication reminders queued', { count: due.length });
  return { queued: due.length };
};
