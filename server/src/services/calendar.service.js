import { google } from 'googleapis';
import { prisma } from '../lib/prisma.js';
import { env, isGoogleConfigured } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { badRequest } from '../lib/errors.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

export const oauthClient = () =>
  new google.auth.OAuth2(env.google.clientId, env.google.clientSecret, env.google.redirectUri);

/** `state` carries the user id so the callback knows whose token this is. */
export const buildConsentUrl = (userId) => {
  if (!isGoogleConfigured()) throw badRequest('Google Calendar is not configured on this server.');
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token even on repeat connects
    scope: SCOPES,
    state: userId
  });
};

export const exchangeCode = async (code, userId) => {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw badRequest('Google did not return a refresh token. Remove the app from your Google account permissions and connect again.');
  }
  return prisma.calendarAccount.upsert({
    where: { userId },
    create: {
      userId,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token || null,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null
    },
    update: {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token || null,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      connectedAt: new Date()
    }
  });
};

export const disconnect = async (userId) => {
  await prisma.calendarAccount.delete({ where: { userId } }).catch(() => {});
  return { connected: false };
};

export const getStatus = async (userId) => {
  const account = await prisma.calendarAccount.findUnique({ where: { userId } });
  return {
    configured: isGoogleConfigured(),
    connected: Boolean(account),
    connectedAt: account?.connectedAt || null
  };
};

const calendarFor = async (userId) => {
  if (!isGoogleConfigured()) return null;
  const account = await prisma.calendarAccount.findUnique({ where: { userId } });
  if (!account) return null;
  const client = oauthClient();
  client.setCredentials({ refresh_token: account.refreshToken });
  return { api: google.calendar({ version: 'v3', auth: client }), calendarId: account.calendarId, userId };
};

const buildEvent = (appointment, audience) => {
  const doctorName = appointment.doctor.user.fullName;
  const patientName = appointment.patient.fullName;
  const isDoctor = audience === 'DOCTOR';

  const description = isDoctor
    ? [
        `Patient: ${patientName}`,
        appointment.symptomReport?.chiefComplaint ? `Chief complaint: ${appointment.symptomReport.chiefComplaint}` : null,
        appointment.symptomReport?.urgency ? `Urgency: ${appointment.symptomReport.urgency}` : null,
        `Pre-visit summary: ${env.clientUrl}/doctor/appointments/${appointment.id}`
      ]
    : [
        `Consultation with Dr ${doctorName} (${appointment.doctor.specialisation}).`,
        `Manage this appointment: ${env.clientUrl}/appointments/${appointment.id}`
      ];

  return {
    summary: isDoctor
      ? `Consult — ${patientName}`
      : `Appointment — Dr ${doctorName}`,
    description: description.filter(Boolean).join('\n'),
    location: env.appName,
    start: { dateTime: new Date(appointment.startsAt).toISOString(), timeZone: appointment.doctor.timezone },
    end: { dateTime: new Date(appointment.endsAt).toISOString(), timeZone: appointment.doctor.timezone },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'email', minutes: 24 * 60 }] }
  };
};

/**
 * Creates or updates the event on both calendars. Every call is wrapped — a
 * Google outage logs a warning and leaves the booking untouched. The worker's
 * `reconcileCalendars` pass picks up anything that did not land.
 */
export const syncAppointment = async (appointmentId) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      patient: true,
      doctor: { include: { user: true } },
      symptomReport: true,
      calendarEvents: true
    }
  });
  if (!appointment || !['HELD', 'CONFIRMED'].includes(appointment.status)) return { skipped: true };

  const targets = [
    { userId: appointment.patientId, audience: 'PATIENT' },
    { userId: appointment.doctor.userId, audience: 'DOCTOR' }
  ];

  const results = [];
  for (const target of targets) {
    // eslint-disable-next-line no-await-in-loop
    const ctx = await calendarFor(target.userId);
    if (!ctx) {
      results.push({ userId: target.userId, status: 'NOT_CONNECTED' });
      continue;
    }
    const existing = appointment.calendarEvents.find((e) => e.userId === target.userId);
    const requestBody = buildEvent(appointment, target.audience);

    try {
      if (existing) {
        // eslint-disable-next-line no-await-in-loop
        await ctx.api.events.update({
          calendarId: ctx.calendarId,
          eventId: existing.externalEventId,
          requestBody
        });
        results.push({ userId: target.userId, status: 'UPDATED' });
      } else {
        // eslint-disable-next-line no-await-in-loop
        const created = await ctx.api.events.insert({ calendarId: ctx.calendarId, requestBody });
        // eslint-disable-next-line no-await-in-loop
        await prisma.calendarEvent.upsert({
          where: { appointmentId_userId: { appointmentId, userId: target.userId } },
          create: { appointmentId, userId: target.userId, externalEventId: created.data.id },
          update: { externalEventId: created.data.id }
        });
        results.push({ userId: target.userId, status: 'CREATED' });
      }
    } catch (err) {
      // 404/410 = the user deleted the event in Google; drop our pointer and
      // let the next sync recreate it.
      if ([404, 410].includes(err.code) && existing) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.calendarEvent.delete({ where: { id: existing.id } }).catch(() => {});
      }
      logger.warn('Calendar sync failed for user', { userId: target.userId, appointmentId, error: err.message });
      results.push({ userId: target.userId, status: 'FAILED', error: err.message });
    }
  }
  return { appointmentId, results };
};

export const removeAppointmentEvents = async (appointmentId) => {
  const events = await prisma.calendarEvent.findMany({ where: { appointmentId } });
  for (const event of events) {
    // eslint-disable-next-line no-await-in-loop
    const ctx = await calendarFor(event.userId);
    if (ctx) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await ctx.api.events.delete({ calendarId: ctx.calendarId, eventId: event.externalEventId });
      } catch (err) {
        if (![404, 410].includes(err.code)) {
          logger.warn('Calendar delete failed', { eventId: event.id, error: err.message });
        }
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await prisma.calendarEvent.delete({ where: { id: event.id } }).catch(() => {});
  }
  return { removed: events.length };
};

/** Worker pass: any confirmed upcoming appointment missing an event gets one. */
export const reconcileCalendars = async (limit = 20) => {
  if (!isGoogleConfigured()) return { checked: 0 };
  const candidates = await prisma.appointment.findMany({
    where: { status: 'CONFIRMED', startsAt: { gte: new Date() } },
    include: { calendarEvents: true, doctor: { select: { userId: true } } },
    take: limit,
    orderBy: { startsAt: 'asc' }
  });

  let repaired = 0;
  for (const appt of candidates) {
    const have = new Set(appt.calendarEvents.map((e) => e.userId));
    const need = [appt.patientId, appt.doctor.userId].some((uid) => !have.has(uid));
    if (!need) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await syncAppointment(appt.id).catch(() => null);
    if (res?.results?.some((r) => r.status === 'CREATED')) repaired += 1;
  }
  return { checked: candidates.length, repaired };
};
