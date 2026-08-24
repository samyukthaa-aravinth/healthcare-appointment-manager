import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { wrap } from '../utils/async.js';

export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role, email: user.email }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn
  });

export const authenticate = wrap(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw unauthorized('Your session has expired. Sign in again.');
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { doctorProfile: { select: { id: true } } }
  });
  if (!user || !user.isActive) throw unauthorized('This account is no longer active.');

  req.user = user;
  req.doctorProfileId = user.doctorProfile?.id || null;
  next();
});

export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
