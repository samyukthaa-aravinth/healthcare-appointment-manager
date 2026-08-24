import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { wrap } from '../utils/async.js';
import { conflict, notFound, badRequest } from '../lib/errors.js';
import { outboxHealth, dispatchOutbox } from '../services/notification.service.js';
import { toDateOnlyString } from '../utils/time.js';

const router = Router();
router.use(authenticate, requireRole('ADMIN'));

const workingHourSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440)
  })
  .refine((w) => w.endMinute > w.startMinute, { message: 'End time must be after start time.' });

const doctorSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(128),
  phone: z.string().max(32).optional(),
  specialisation: z.string().min(2).max(120),
  qualification: z.string().max(200).optional(),
  bio: z.string().max(1000).optional(),
  consultationFee: z.number().int().min(0).max(1000000).optional(),
  slotDurationMinutes: z.number().int().min(5).max(240).optional(),
  bufferMinutes: z.number().int().min(0).max(120).optional(),
  timezone: z.string().max(64).optional(),
  workingHours: z.array(workingHourSchema).max(21).optional()
});

const shape = (d) => ({
  id: d.id,
  userId: d.userId,
  fullName: d.user.fullName,
  email: d.user.email,
  phone: d.user.phone,
  isActive: d.user.isActive,
  specialisation: d.specialisation,
  qualification: d.qualification,
  bio: d.bio,
  consultationFee: d.consultationFee,
  slotDurationMinutes: d.slotDurationMinutes,
  bufferMinutes: d.bufferMinutes,
  timezone: d.timezone,
  workingHours: d.workingHours,
  leaves: d.leaves?.map((l) => ({ id: l.id, date: toDateOnlyString(l.date), reason: l.reason }))
});

const fullInclude = {
  user: { select: { fullName: true, email: true, phone: true, isActive: true } },
  workingHours: { orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
  leaves: { where: { date: { gte: new Date(Date.now() - 86400000) } }, orderBy: { date: 'asc' } }
};

router.get(
  '/doctors',
  wrap(async (_req, res) => {
    const doctors = await prisma.doctorProfile.findMany({ include: fullInclude, orderBy: { createdAt: 'desc' } });
    res.json({ doctors: doctors.map(shape) });
  })
);

router.post(
  '/doctors',
  validate(doctorSchema),
  wrap(async (req, res) => {
    const { fullName, email, password, phone, workingHours = [], ...profile } = req.body;
    if (await prisma.user.findUnique({ where: { email } })) {
      throw conflict('An account with that email already exists.', 'EMAIL_TAKEN');
    }

    const doctor = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          fullName,
          email,
          phone: phone || null,
          role: 'DOCTOR',
          passwordHash: await bcrypt.hash(password, 10)
        }
      });
      return tx.doctorProfile.create({
        data: {
          userId: user.id,
          ...profile,
          workingHours: { create: workingHours }
        },
        include: fullInclude
      });
    });

    res.status(201).json({ doctor: shape(doctor) });
  })
);

router.patch(
  '/doctors/:doctorId',
  validate(
    doctorSchema
      .partial()
      .omit({ password: true })
      .extend({ isActive: z.boolean().optional() })
  ),
  wrap(async (req, res) => {
    const { fullName, email, phone, isActive, workingHours, ...profile } = req.body;
    const existing = await prisma.doctorProfile.findUnique({ where: { id: req.params.doctorId } });
    if (!existing) throw notFound('Doctor not found.');

    const doctor = await prisma.$transaction(async (tx) => {
      if (fullName || email || phone !== undefined || isActive !== undefined) {
        await tx.user.update({
          where: { id: existing.userId },
          data: {
            ...(fullName ? { fullName } : {}),
            ...(email ? { email } : {}),
            ...(phone !== undefined ? { phone } : {}),
            ...(isActive !== undefined ? { isActive } : {})
          }
        });
      }
      if (workingHours) {
        // Replacing the schedule never touches existing bookings — those live
        // on slot locks, so a shrunk schedule leaves booked slots intact and
        // simply stops offering new ones.
        await tx.workingHour.deleteMany({ where: { doctorId: existing.id } });
        await tx.workingHour.createMany({
          data: workingHours.map((w) => ({ ...w, doctorId: existing.id }))
        });
      }
      return tx.doctorProfile.update({
        where: { id: existing.id },
        data: profile,
        include: fullInclude
      });
    });

    res.json({ doctor: shape(doctor) });
  })
);

router.post(
  '/doctors/:doctorId/reset-password',
  validate(z.object({ password: z.string().min(8).max(128) })),
  wrap(async (req, res) => {
    const doctor = await prisma.doctorProfile.findUnique({ where: { id: req.params.doctorId } });
    if (!doctor) throw notFound('Doctor not found.');
    await prisma.user.update({
      where: { id: doctor.userId },
      data: { passwordHash: await bcrypt.hash(req.body.password, 10) }
    });
    res.json({ ok: true });
  })
);

router.delete(
  '/doctors/:doctorId',
  wrap(async (req, res) => {
    const doctor = await prisma.doctorProfile.findUnique({ where: { id: req.params.doctorId } });
    if (!doctor) throw notFound('Doctor not found.');
    const upcoming = await prisma.appointment.count({
      where: { doctorId: doctor.id, status: { in: ['HELD', 'CONFIRMED'] }, startsAt: { gte: new Date() } }
    });
    if (upcoming > 0) {
      throw badRequest(
        `This doctor has ${upcoming} upcoming appointment(s). Deactivate the account or cancel those first.`
      );
    }
    await prisma.user.update({ where: { id: doctor.userId }, data: { isActive: false } });
    res.json({ ok: true, deactivated: true });
  })
);

router.get(
  '/overview',
  wrap(async (_req, res) => {
    const now = new Date();
    const [doctors, patients, upcoming, held, cancelled, outbox, fallbacks] = await Promise.all([
      prisma.doctorProfile.count(),
      prisma.user.count({ where: { role: 'PATIENT' } }),
      prisma.appointment.count({ where: { status: 'CONFIRMED', startsAt: { gte: now } } }),
      prisma.appointment.count({ where: { status: 'HELD' } }),
      prisma.appointment.count({ where: { status: 'CANCELLED' } }),
      outboxHealth(),
      prisma.symptomReport.count({ where: { llmStatus: 'FALLBACK' } })
    ]);
    res.json({
      doctors,
      patients,
      upcomingAppointments: upcoming,
      activeHolds: held,
      cancelledAppointments: cancelled,
      notifications: outbox,
      llmFallbacks: fallbacks
    });
  })
);

router.get(
  '/notifications',
  wrap(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    const rows = await prisma.notificationOutbox.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    res.json({ notifications: rows });
  })
);

/** Manually drain the outbox — handy when demoing retry behaviour. */
router.post(
  '/notifications/flush',
  wrap(async (_req, res) => {
    res.json(await dispatchOutbox(50));
  })
);

router.post(
  '/notifications/:id/retry',
  wrap(async (req, res) => {
    const row = await prisma.notificationOutbox.update({
      where: { id: req.params.id },
      data: { status: 'PENDING', nextAttemptAt: new Date(), attempts: 0, lastError: null }
    });
    res.json({ notification: row });
  })
);

export default router;
