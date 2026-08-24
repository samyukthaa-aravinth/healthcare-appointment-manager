import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { signToken, authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { wrap } from '../utils/async.js';
import { unauthorized, conflict } from '../lib/errors.js';
import { enqueueEmail } from '../services/notification.service.js';

const router = Router();

const registerSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email().toLowerCase(),
  password: z.string().min(8, 'Use at least 8 characters.').max(128),
  phone: z.string().max(32).optional()
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1)
});

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  phone: u.phone,
  role: u.role,
  doctorProfileId: u.doctorProfile?.id || null
});

// Patients self-register. Doctor and admin accounts are created by an admin.
router.post(
  '/register',
  validate(registerSchema),
  wrap(async (req, res) => {
    const { fullName, email, password, phone } = req.body;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw conflict('An account with that email already exists.', 'EMAIL_TAKEN');

    const user = await prisma.user.create({
      data: { fullName, email, phone: phone || null, passwordHash: await bcrypt.hash(password, 10), role: 'PATIENT' }
    });

    await enqueueEmail({
      dedupeKey: `welcome:${user.id}`,
      template: 'WELCOME',
      toEmail: user.email,
      toName: user.fullName,
      payload: { fullName: user.fullName }
    });

    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  })
);

router.post(
  '/login',
  validate(loginSchema),
  wrap(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { email: req.body.email },
      include: { doctorProfile: { select: { id: true } } }
    });
    if (!user || !user.isActive) throw unauthorized('Email or password is incorrect.');
    const ok = await bcrypt.compare(req.body.password, user.passwordHash);
    if (!ok) throw unauthorized('Email or password is incorrect.');
    res.json({ token: signToken(user), user: publicUser(user) });
  })
);

router.get('/me', authenticate, wrap(async (req, res) => {
  res.json({ user: publicUser(req.user) });
}));

router.patch(
  '/me',
  authenticate,
  validate(z.object({ fullName: z.string().min(2).max(120).optional(), phone: z.string().max(32).optional() })),
  wrap(async (req, res) => {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: req.body,
      include: { doctorProfile: { select: { id: true } } }
    });
    res.json({ user: publicUser(user) });
  })
);

export default router;
