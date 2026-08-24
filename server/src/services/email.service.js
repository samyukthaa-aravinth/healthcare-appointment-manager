import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

let transporter = null;

const build = () => {
  if (transporter) return transporter;

  if (env.email.transport === 'smtp') {
    transporter = nodemailer.createTransport({
      host: env.email.smtp.host,
      port: env.email.smtp.port,
      secure: env.email.smtp.secure,
      auth: env.email.smtp.user ? { user: env.email.smtp.user, pass: env.email.smtp.pass } : undefined
    });
  } else if (env.email.transport === 'sendgrid') {
    // SendGrid's SMTP relay — no extra SDK needed.
    transporter = nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: env.email.sendgridApiKey }
    });
  } else {
    // console transport: renders the message to logs, never sends.
    transporter = {
      sendMail: async (msg) => {
        logger.info('EMAIL (console transport)', {
          to: msg.to,
          subject: msg.subject,
          preview: (msg.text || '').slice(0, 240)
        });
        return { messageId: `console-${Date.now()}` };
      }
    };
  }
  return transporter;
};

/** Throws on failure — the caller (outbox worker) decides about retries. */
export const sendEmail = async ({ to, subject, html, text }) => {
  if (!to) throw new Error('Recipient address missing');
  const info = await build().sendMail({ from: env.email.from, to, subject, html, text });
  return info.messageId;
};

export const emailTransportName = () => env.email.transport;
