import cron from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { dispatchOutbox } from '../services/notification.service.js';
import { expireStaleHolds } from '../services/booking.service.js';
import { dispatchDueMedicationReminders } from '../services/visit.service.js';
import { reconcileCalendars } from '../services/calendar.service.js';
import { enqueueEmail } from '../services/notification.service.js';
import { formatSlot, addHours } from '../utils/time.js';

/**
 * All background work lives here. It runs inside the API process by default
 * (RUN_WORKER_IN_PROCESS=true) because free hosting tiers give you one process;
 * set it to false and run `npm run worker` as a separate service to scale out.
 *
 * Every job is wrapped in `guard`, which swallows errors and prevents overlap —
 * a slow run must never stack up on the next tick.
 */

const running = new Set();

const guard = (name, fn) => async () => {
  if (running.has(name)) {
    logger.warn(`Skipping ${name}, previous run still going`);
    return;
  }
  running.add(name);
  const started = Date.now();
  try {
    const result = await fn();
    if (result && Object.values(result).some((v) => typeof v === 'number' && v > 0)) {
      logger.info(`Job ${name} finished in ${Date.now() - started}ms`, result);
    }
  } catch (err) {
    logger.error(`Job ${name} failed`, err);
  } finally {
    running.delete(name);
  }
};

/** Queues a reminder email for every appointment starting inside the lead window. */
export const queueAppointmentReminders = async () => {
  const lead = env.worker.reminderLeadHours;
  const windowStart = addHours(new Date(), lead - 0.5);
  const windowEnd = addHours(new Date(), lead + 0.5);

  const appointments = await prisma.appointment.findMany({
    where: { status: 'CONFIRMED', startsAt: { gte: windowStart, lte: windowEnd } },
    include: {
      patient: { select: { email: true, fullName: true } },
      doctor: { include: { user: { select: { fullName: true, email: true } } } }
    },
    take: 200
  });

  let queued = 0;
  for (const a of appointments) {
    const payload = {
      appointmentId: a.id,
      patientName: a.patient.fullName,
      doctorName: a.doctor.user.fullName,
      slotLabel: formatSlot(a.startsAt, a.doctor.timezone)
    };
    // dedupeKey pins the reminder to the appointment + lead window, so a
    // restart mid-run cannot double-send.
    // eslint-disable-next-line no-await-in-loop
    const row = await enqueueEmail({
      dedupeKey: `reminder:${lead}h:${a.id}`,
      template: 'APPOINTMENT_REMINDER',
      toEmail: a.patient.email,
      toName: a.patient.fullName,
      payload
    });
    if (row) queued += 1;
  }
  return { queued, considered: appointments.length };
};

const JOBS = [
  // Drain the email outbox — the retry engine.
  { name: 'outbox', schedule: '*/1 * * * *', fn: () => dispatchOutbox(25) },
  // Release slots whose hold lapsed.
  { name: 'expire-holds', schedule: '*/2 * * * *', fn: expireStaleHolds },
  // Medication reminders that have come due.
  { name: 'medication-reminders', schedule: '*/5 * * * *', fn: () => dispatchDueMedicationReminders(50) },
  // 24-hour appointment reminders.
  { name: 'appointment-reminders', schedule: '0 * * * *', fn: queueAppointmentReminders },
  // Repair calendar events that failed to create during a Google outage.
  { name: 'calendar-reconcile', schedule: '*/15 * * * *', fn: () => reconcileCalendars(20) }
];

let started = false;

export const startWorker = () => {
  if (started) return;
  started = true;
  for (const job of JOBS) cron.schedule(job.schedule, guard(job.name, job.fn));
  logger.info('Background worker started', { jobs: JOBS.map((j) => j.name) });
};

/** Runs one pass of everything — used by `npm run worker -- --once` and tests. */
export const runAllOnce = async () => {
  const out = {};
  for (const job of JOBS) {
    // eslint-disable-next-line no-await-in-loop
    out[job.name] = await job.fn().catch((err) => ({ error: err.message }));
  }
  return out;
};

// Standalone mode: `npm run worker`
const isMain = process.argv[1] && process.argv[1].endsWith('worker.js');
if (isMain) {
  if (process.argv.includes('--once')) {
    runAllOnce()
      .then((r) => {
        logger.info('One-shot worker pass complete', r);
        return prisma.$disconnect();
      })
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error('One-shot worker pass failed', err);
        process.exit(1);
      });
  } else {
    startWorker();
    logger.info('Worker running standalone. Ctrl-C to stop.');
  }
}
