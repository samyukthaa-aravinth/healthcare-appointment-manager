import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { wrap } from '../utils/async.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import * as calendar from '../services/calendar.service.js';

const router = Router();

router.get('/status', authenticate, wrap(async (req, res) => {
  res.json(await calendar.getStatus(req.user.id));
}));

/** Returns the consent URL; the client opens it in the same tab. */
router.get('/google/connect', authenticate, wrap(async (req, res) => {
  res.json({ url: calendar.buildConsentUrl(req.user.id) });
}));

/**
 * Google redirects the browser here — no Authorization header available, so the
 * user id travels in the `state` parameter that we set when building the URL.
 */
router.get('/google/callback', wrap(async (req, res) => {
  const { code, state, error } = req.query;
  const back = (status, message) =>
    res.redirect(`${env.clientUrl}/settings?calendar=${status}${message ? `&message=${encodeURIComponent(message)}` : ''}`);

  if (error) return back('error', String(error));
  if (!code || !state) return back('error', 'Google did not send an authorisation code.');

  try {
    await calendar.exchangeCode(String(code), String(state));
    return back('connected');
  } catch (err) {
    logger.error('Google OAuth exchange failed', err);
    return back('error', err.message);
  }
}));

router.post('/google/disconnect', authenticate, wrap(async (req, res) => {
  res.json(await calendar.disconnect(req.user.id));
}));

/** Force a re-sync for one appointment (used by the "Sync now" button). */
router.post('/appointments/:appointmentId/sync', authenticate, wrap(async (req, res) => {
  res.json(await calendar.syncAppointment(req.params.appointmentId));
}));

export default router;
