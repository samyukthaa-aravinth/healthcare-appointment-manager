import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { wrap } from '../utils/async.js';
import { forbidden, notFound, badRequest } from '../lib/errors.js';
import { getAvailability, getAvailabilityRange, getDoctorOrThrow } from '../services/slot.service.js';
import { markLeave, removeLeave, previewLeaveImpact, serialiseAppointment, appointmentInclude } from '../services/booking.service.js';
import { submitVisitNote } from '../services/visit.service.js';
import { toDateOnlyString } from '../utils/time.js';

const router = Router();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

const doctorCard = (d) => ({
  id: d.id,
  fullName: d.user.fullName,
  email: d.user.email,
  specialisation: d.specialisation,
  qualification: d.qualification,
  bio: d.bio,
  consultationFee: d.consultationFee,
  slotDurationMinutes: d.slotDurationMinutes,
  bufferMinutes: d.bufferMinutes,
  timezone: d.timezone,
  workingHours: d.workingHours?.map((w) => ({
    id: w.id,
    dayOfWeek: w.dayOfWeek,
    startMinute: w.startMinute,
    endMinute: w.endMinute
  })),
  upcomingLeave: d.leaves?.map((l) => ({ id: l.id, date: toDateOnlyString(l.date), reason: l.reason }))
});

/* ---------------- public directory ---------------- */

router.get(
  '/',
  wrap(async (req, res) => {
    const { specialisation, q } = req.query;
    const where = {
      user: { isActive: true },
      ...(specialisation ? { specialisation: { equals: String(specialisation), mode: 'insensitive' } } : {}),
      ...(q
        ? {
            OR: [
              { user: { fullName: { contains: String(q), mode: 'insensitive' } } },
              { specialisation: { contains: String(q), mode: 'insensitive' } }
            ]
          }
        : {})
    };

    const doctors = await prisma.doctorProfile.findMany({
      where,
      include: {
        user: { select: { fullName: true, email: true } },
        workingHours: { orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] }
      },
      orderBy: { specialisation: 'asc' }
    });
    res.json({ doctors: doctors.map(doctorCard) });
  })
);

router.get(
  '/specialisations',
  wrap(async (_req, res) => {
    const rows = await prisma.doctorProfile.groupBy({
      by: ['specialisation'],
      _count: { _all: true },
      orderBy: { specialisation: 'asc' }
    });
    res.json({ specialisations: rows.map((r) => ({ name: r.specialisation, doctorCount: r._count._all })) });
  })
);

router.get(
  '/:doctorId',
  wrap(async (req, res) => {
    const doctor = await prisma.doctorProfile.findUnique({
      where: { id: req.params.doctorId },
      include: {
        user: { select: { fullName: true, email: true, isActive: true } },
        workingHours: { orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
        leaves: { where: { date: { gte: new Date(Date.now() - 86400000) } }, orderBy: { date: 'asc' }, take: 30 }
      }
    });
    if (!doctor || !doctor.user.isActive) throw notFound('That doctor is not available.');
    res.json({ doctor: doctorCard(doctor) });
  })
);

router.get(
  '/:doctorId/availability',
  wrap(async (req, res) => {
    const date = req.query.date ? String(req.query.date) : toDateOnlyString(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Use a date in YYYY-MM-DD format.');
    res.json(await getAvailability(req.params.doctorId, date));
  })
);

router.get(
  '/:doctorId/availability-range',
  wrap(async (req, res) => {
    const from = req.query.from ? String(req.query.from) : toDateOnlyString(new Date());
    const days = Math.min(Number(req.query.days) || 7, 21);
    res.json({ days: await getAvailabilityRange(req.params.doctorId, from, days) });
  })
);

/* ---------------- doctor portal ---------------- */

const requireOwnProfile = wrap(async (req, _res, next) => {
  const { doctorId } = req.params;
  if (req.user.role === 'ADMIN') return next();
  if (!req.doctorProfileId || req.doctorProfileId !== doctorId) throw forbidden();
  next();
});

router.get(
  '/me/schedule',
  authenticate,
  requireRole('DOCTOR'),
  wrap(async (req, res) => {
    const doctor = await getDoctorOrThrow(req.doctorProfileId);
    const from = req.query.from ? new Date(String(req.query.from)) : new Date();
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 14 * 86400000);

    const appointments = await prisma.appointment.findMany({
      where: {
        doctorId: doctor.id,
        startsAt: { gte: from, lte: to },
        status: { in: ['CONFIRMED', 'COMPLETED', 'HELD'] }
      },
      include: appointmentInclude,
      orderBy: { startsAt: 'asc' }
    });

    res.json({
      doctor: doctorCard(doctor),
      appointments: appointments.map(serialiseAppointment)
    });
  })
);

router.get(
  '/:doctorId/leave/preview',
  authenticate,
  requireRole('DOCTOR', 'ADMIN'),
  requireOwnProfile,
  validate(z.object({ date: dateOnly }), 'query'),
  wrap(async (req, res) => {
    res.json(await previewLeaveImpact(req.params.doctorId, req.validatedQuery.date));
  })
);

router.post(
  '/:doctorId/leave',
  authenticate,
  requireRole('DOCTOR', 'ADMIN'),
  requireOwnProfile,
  validate(z.object({ date: dateOnly, reason: z.string().max(300).optional(), confirm: z.boolean().optional() })),
  wrap(async (req, res) => {
    const result = await markLeave({
      doctorId: req.params.doctorId,
      dateString: req.body.date,
      reason: req.body.reason,
      confirm: req.body.confirm === true
    });
    res.status(201).json(result);
  })
);

router.delete(
  '/:doctorId/leave/:date',
  authenticate,
  requireRole('DOCTOR', 'ADMIN'),
  requireOwnProfile,
  wrap(async (req, res) => {
    res.json(await removeLeave(req.params.doctorId, req.params.date));
  })
);

const visitNoteSchema = z.object({
  clinicalNotes: z.string().min(10, 'Write at least a sentence of notes.').max(8000),
  diagnosis: z.string().max(500).optional(),
  prescriptions: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        dosage: z.string().max(80).optional(),
        frequency: z.string().max(60).optional(),
        durationDays: z.number().int().min(1).max(90).nullable().optional(),
        instructions: z.string().max(300).optional()
      })
    )
    .max(15)
    .optional()
    .default([]),
  followUpAt: z.string().datetime().optional().nullable(),
  followUpNotes: z.string().max(1000).optional()
});

router.post(
  '/appointments/:appointmentId/visit-note',
  authenticate,
  requireRole('DOCTOR', 'ADMIN'),
  validate(visitNoteSchema),
  wrap(async (req, res) => {
    const result = await submitVisitNote({
      appointmentId: req.params.appointmentId,
      actorUserId: req.user.id,
      isAdmin: req.user.role === 'ADMIN',
      payload: req.body
    });
    res.status(201).json(result);
  })
);

export default router;
