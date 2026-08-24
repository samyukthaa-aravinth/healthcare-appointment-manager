import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { wrap } from '../utils/async.js';
import { forbidden, notFound } from '../lib/errors.js';
import {
  holdSlot,
  confirmAppointment,
  cancelAppointment,
  rescheduleAppointment,
  serialiseAppointment,
  appointmentInclude,
  runPreVisitTriage
} from '../services/booking.service.js';

const router = Router();

// Booking is the one endpoint worth protecting from a hot loop.
const bookingLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many booking attempts. Wait a minute and try again.' } }
});

const holdSchema = z.object({
  doctorId: z.string().min(1),
  startsAt: z.string().datetime({ message: 'Send an ISO 8601 timestamp.' }),
  reasonText: z.string().max(300).optional()
});

const symptomSchema = z.object({
  symptomsText: z.string().min(10, 'Describe your symptoms in a sentence or two.').max(4000),
  durationDays: z.number().int().min(0).max(3650).optional().nullable(),
  severity: z.number().int().min(1).max(10).optional().nullable(),
  existingConditions: z.string().max(1000).optional(),
  currentMedications: z.string().max(1000).optional(),
  allergies: z.string().max(500).optional()
});

const canSee = (appointment, user) =>
  appointment.patientId === user.id || appointment.doctor.userId === user.id || user.role === 'ADMIN';

/** Step 1 — reserve the slot before the patient fills the symptom form. */
router.post(
  '/hold',
  authenticate,
  requireRole('PATIENT', 'ADMIN'),
  bookingLimiter,
  validate(holdSchema),
  wrap(async (req, res) => {
    const appointment = await holdSlot({
      patientId: req.user.id,
      doctorId: req.body.doctorId,
      startsAt: req.body.startsAt,
      reasonText: req.body.reasonText
    });
    res.status(201).json({ appointment });
  })
);

/** Step 2 — symptom form + confirmation. Triggers triage, email and calendar. */
router.post(
  '/:appointmentId/confirm',
  authenticate,
  requireRole('PATIENT', 'ADMIN'),
  validate(symptomSchema),
  wrap(async (req, res) => {
    const appointment = await confirmAppointment({
      appointmentId: req.params.appointmentId,
      patientId: req.user.id,
      form: req.body
    });
    res.json({ appointment });
  })
);

router.get(
  '/',
  authenticate,
  wrap(async (req, res) => {
    const { scope = 'upcoming', status } = req.query;
    const now = new Date();

    const roleWhere =
      req.user.role === 'DOCTOR'
        ? { doctorId: req.doctorProfileId || '__none__' }
        : req.user.role === 'ADMIN'
          ? {}
          : { patientId: req.user.id };

    const scopeWhere =
      scope === 'past'
        ? { OR: [{ startsAt: { lt: now } }, { status: { in: ['COMPLETED', 'CANCELLED'] } }] }
        : scope === 'all'
          ? {}
          : { startsAt: { gte: now }, status: { in: ['HELD', 'CONFIRMED'] } };

    const appointments = await prisma.appointment.findMany({
      where: { ...roleWhere, ...scopeWhere, ...(status ? { status: String(status) } : {}) },
      include: appointmentInclude,
      orderBy: { startsAt: scope === 'past' ? 'desc' : 'asc' },
      take: 100
    });

    res.json({ appointments: appointments.map(serialiseAppointment) });
  })
);

router.get(
  '/:appointmentId',
  authenticate,
  wrap(async (req, res) => {
    const appointment = await prisma.appointment.findUnique({
      where: { id: req.params.appointmentId },
      include: appointmentInclude
    });
    if (!appointment) throw notFound('Appointment not found.');
    if (!canSee(appointment, req.user)) throw forbidden();

    const data = serialiseAppointment(appointment);
    // Patients see the friendly summary, not the raw clinical triage.
    if (req.user.role === 'PATIENT' && data.symptomReport) {
      delete data.symptomReport.llmError;
      delete data.symptomReport.suggestedQuestions;
    }
    if (req.user.role === 'PATIENT' && data.visitNote) {
      data.visitNote = {
        patientSummary: data.visitNote.patientSummary,
        medicationSchedule: data.visitNote.medicationSchedule,
        followUpSteps: data.visitNote.followUpSteps,
        followUpAt: data.visitNote.followUpAt,
        prescriptions: data.visitNote.prescriptions,
        llmStatus: data.visitNote.llmStatus,
        createdAt: data.visitNote.createdAt
      };
    }
    res.json({ appointment: data });
  })
);

router.post(
  '/:appointmentId/cancel',
  authenticate,
  validate(z.object({ reason: z.string().max(500).optional() })),
  wrap(async (req, res) => {
    const cancelledBy =
      req.user.role === 'ADMIN' ? 'ADMIN' : req.user.role === 'DOCTOR' ? 'DOCTOR' : 'PATIENT';
    const result = await cancelAppointment({
      appointmentId: req.params.appointmentId,
      actor: req.user,
      cancelledBy,
      reason: req.body.reason
    });
    res.json(result);
  })
);

router.post(
  '/:appointmentId/reschedule',
  authenticate,
  bookingLimiter,
  validate(z.object({ startsAt: z.string().datetime() })),
  wrap(async (req, res) => {
    const appointment = await rescheduleAppointment({
      appointmentId: req.params.appointmentId,
      actor: req.user,
      newStartsAt: req.body.startsAt
    });
    res.json({ appointment });
  })
);

/** Manual retry when the triage fell back — visible on the doctor's view. */
router.post(
  '/:appointmentId/retry-triage',
  authenticate,
  requireRole('DOCTOR', 'ADMIN'),
  wrap(async (req, res) => {
    const report = await runPreVisitTriage(req.params.appointmentId);
    if (!report) throw notFound('No symptom form on this appointment.');
    res.json({ symptomReport: report });
  })
);

export default router;
