import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { sendEmail } from './email.service.js';
import { renderTemplate } from './email.templates.js';

/**
 * Transactional outbox.
 *
 * Nothing in this codebase calls sendEmail() directly from a request handler.
 * Callers enqueue a row; the worker drains it. That gives us three things the
 * brief asks for: a booking never fails because SendGrid is down, no message is
 * silently lost, and retries are bounded and observable.
 *
 * `dedupeKey` makes enqueueing idempotent — re-running a job or retrying a
 * request cannot produce a duplicate email.
 */

const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360];

export const enqueueEmail = async ({ dedupeKey, template, toEmail, toName, payload, tx }) => {
  const db = tx || prisma;
  if (!toEmail) {
    logger.warn('Skipping notification, no recipient address', { template, dedupeKey });
    return null;
  }
  try {
    return await db.notificationOutbox.create({
      data: { dedupeKey, template, toEmail, toName, payload: payload || {} }
    });
  } catch (err) {
    if (err.code === 'P2002') return null; // already queued — idempotent
    throw err;
  }
};

/** Processes a batch of due messages. Returns counts for logging/health. */
export const dispatchOutbox = async (limit = 25) => {
  const now = new Date();
  const due = await prisma.notificationOutbox.findMany({
    where: { status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit
  });

  let sent = 0;
  let failed = 0;

  for (const msg of due) {
    const attempts = msg.attempts + 1;
    try {
      const { subject, html, text } = renderTemplate(msg.template, msg.payload);
      await sendEmail({ to: msg.toEmail, subject, html, text });
      await prisma.notificationOutbox.update({
        where: { id: msg.id },
        data: { status: 'SENT', attempts, sentAt: new Date(), lastError: null }
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      const exhausted = attempts >= msg.maxAttempts;
      const wait = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
      await prisma.notificationOutbox.update({
        where: { id: msg.id },
        data: {
          status: exhausted ? 'DEAD' : 'FAILED',
          attempts,
          lastError: String(err.message).slice(0, 500),
          nextAttemptAt: new Date(Date.now() + wait * 60000)
        }
      });
      logger[exhausted ? 'error' : 'warn'](
        exhausted ? 'Notification exhausted retries' : 'Notification failed, will retry',
        { id: msg.id, template: msg.template, attempts, error: err.message }
      );
    }
  }

  if (sent || failed) logger.info('Outbox drained', { sent, failed, considered: due.length });
  return { sent, failed, considered: due.length };
};

export const outboxHealth = async () => {
  const grouped = await prisma.notificationOutbox.groupBy({ by: ['status'], _count: { _all: true } });
  return grouped.reduce((acc, g) => ({ ...acc, [g.status]: g._count._all }), {});
};
