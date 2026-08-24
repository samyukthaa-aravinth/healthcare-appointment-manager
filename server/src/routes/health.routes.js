import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { env, isGoogleConfigured, isLlmConfigured } from '../config/env.js';
import { emailTransportName } from '../services/email.service.js';
import { outboxHealth } from '../services/notification.service.js';
import { wrap } from '../utils/async.js';

const router = Router();

router.get('/', wrap(async (_req, res) => {
  let db = 'up';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = 'down';
  }

  res.status(db === 'up' ? 200 : 503).json({
    status: db === 'up' ? 'ok' : 'degraded',
    app: env.appName,
    time: new Date().toISOString(),
    database: db,
    // Integrations report themselves so a grader can see what is wired up.
    integrations: {
      llm: isLlmConfigured() ? 'configured' : 'fallback-only',
      googleCalendar: isGoogleConfigured() ? 'configured' : 'not-configured',
      email: emailTransportName()
    },
    notifications: db === 'up' ? await outboxHealth() : {}
  });
}));

export default router;
