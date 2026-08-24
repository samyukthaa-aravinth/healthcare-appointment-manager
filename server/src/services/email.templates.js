import { env } from '../config/env.js';

const INK = '#0F1B2D';
const TEAL = '#0E7C7B';
const MUTED = '#5A6B80';

const layout = (title, bodyHtml, footerNote) => `<!doctype html>
<html><body style="margin:0;background:#EEF1F5;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #DDE3EB">
      <tr><td style="background:${INK};padding:18px 24px;color:#fff;font-size:13px;letter-spacing:.14em;text-transform:uppercase">${env.appName}</td></tr>
      <tr><td style="padding:28px 24px">
        <h1 style="margin:0 0 16px;font-size:21px;line-height:1.3">${title}</h1>
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:16px 24px;background:#F6F8FA;color:${MUTED};font-size:12px;line-height:1.5;border-top:1px solid #DDE3EB">
        ${footerNote || 'This is an automated message. Do not reply to this email.'}
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

const p = (text) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6">${text}</p>`;

const factTable = (rows) => `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 18px;border-collapse:collapse">
  ${rows
    .filter(Boolean)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 0;color:${MUTED};font-size:13px;width:38%;vertical-align:top">${k}</td><td style="padding:8px 0;font-size:14px;font-weight:600">${v}</td></tr>`
    )
    .join('')}
</table>`;

const button = (href, label) =>
  `<a href="${href}" style="display:inline-block;background:${TEAL};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:600">${label}</a>`;

const list = (items) =>
  `<ul style="margin:0 0 14px;padding-left:18px;font-size:15px;line-height:1.7">${items
    .map((i) => `<li>${i}</li>`)
    .join('')}</ul>`;

const esc = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const nl2br = (s) => esc(s).replace(/\n/g, '<br/>');

/**
 * Each template returns { subject, html, text }.
 * `payload` is whatever notification.service stored on the outbox row.
 */
export const templates = {
  BOOKING_CONFIRMATION_PATIENT: (d) => ({
    subject: `Appointment confirmed — Dr ${d.doctorName}, ${d.slotLabel}`,
    html: layout(
      'Your appointment is confirmed',
      `${p(`Hello ${esc(d.patientName)}, your appointment is booked.`)}
       ${factTable([
         ['Doctor', `Dr ${esc(d.doctorName)}`],
         ['Specialisation', esc(d.specialisation)],
         ['When', esc(d.slotLabel)],
         ['Reference', esc(d.appointmentId)]
       ])}
       ${p('Please arrive 10 minutes early. You can cancel or reschedule from your dashboard.')}
       ${button(`${env.clientUrl}/appointments/${d.appointmentId}`, 'View appointment')}`
    ),
    text: `Appointment confirmed with Dr ${d.doctorName} (${d.specialisation}) on ${d.slotLabel}. Reference ${d.appointmentId}.`
  }),

  BOOKING_CONFIRMATION_DOCTOR: (d) => ({
    subject: `New booking — ${d.patientName}, ${d.slotLabel}`,
    html: layout(
      'A new appointment was booked',
      `${factTable([
        ['Patient', esc(d.patientName)],
        ['When', esc(d.slotLabel)],
        ['Urgency', esc(d.urgency || 'Pending triage')],
        ['Chief complaint', esc(d.chiefComplaint || '—')]
      ])}
       ${p('The pre-visit summary is on your dashboard.')}
       ${button(`${env.clientUrl}/doctor/appointments/${d.appointmentId}`, 'Open pre-visit summary')}`
    ),
    text: `New booking: ${d.patientName} on ${d.slotLabel}. Urgency: ${d.urgency || 'pending'}.`
  }),

  APPOINTMENT_REMINDER: (d) => ({
    subject: `Reminder — appointment with Dr ${d.doctorName} on ${d.slotLabel}`,
    html: layout(
      'Your appointment is coming up',
      `${p(`Hello ${esc(d.patientName)}, this is a reminder for your visit.`)}
       ${factTable([
         ['Doctor', `Dr ${esc(d.doctorName)}`],
         ['When', esc(d.slotLabel)]
       ])}
       ${p('If you can no longer attend, please cancel so the slot can be released.')}
       ${button(`${env.clientUrl}/appointments/${d.appointmentId}`, 'View appointment')}`
    ),
    text: `Reminder: appointment with Dr ${d.doctorName} on ${d.slotLabel}.`
  }),

  APPOINTMENT_CANCELLED: (d) => ({
    subject: `Appointment cancelled — ${d.slotLabel}`,
    html: layout(
      'Your appointment was cancelled',
      `${p(`The appointment with Dr ${esc(d.doctorName)} on ${esc(d.slotLabel)} has been cancelled${
        d.cancelledBy ? ` by the ${esc(String(d.cancelledBy).toLowerCase())}` : ''
      }.`)}
       ${d.cancelReason ? p(`Reason: ${esc(d.cancelReason)}`) : ''}
       ${p('You can book another slot whenever you are ready.')}
       ${button(`${env.clientUrl}/doctors`, 'Find another slot')}`
    ),
    text: `Appointment with Dr ${d.doctorName} on ${d.slotLabel} was cancelled. ${d.cancelReason || ''}`
  }),

  DOCTOR_LEAVE_CONFLICT: (d) => ({
    subject: `Action needed — Dr ${d.doctorName} is unavailable on ${d.dateLabel}`,
    html: layout(
      'Your appointment needs rebooking',
      `${p(`Hello ${esc(d.patientName)}, Dr ${esc(d.doctorName)} is unavailable on ${esc(d.dateLabel)}, so your ${esc(
        d.slotLabel
      )} appointment has been cancelled.`)}
       ${d.reason ? p(`Reason given: ${esc(d.reason)}`) : ''}
       ${p('We are sorry for the disruption. Please pick a new slot — nearby openings are shown below.')}
       ${d.alternatives?.length ? list(d.alternatives.map(esc)) : ''}
       ${button(`${env.clientUrl}/doctors/${d.doctorId}`, 'Choose a new slot')}`
    ),
    text: `Dr ${d.doctorName} is unavailable on ${d.dateLabel}. Your ${d.slotLabel} appointment was cancelled. Please rebook.`
  }),

  POST_VISIT_SUMMARY: (d) => ({
    subject: `Your visit summary — Dr ${d.doctorName}, ${d.slotLabel}`,
    html: layout(
      'Summary of your visit',
      `${p(nl2br(d.patientSummary))}
       ${
         d.medicationSchedule?.length
           ? `<h2 style="font-size:15px;margin:20px 0 8px">Your medicines</h2>${list(
               d.medicationSchedule.map(
                 (m) =>
                   `<strong>${esc(m.name)}</strong>${m.dosage ? ` — ${esc(m.dosage)}` : ''}${
                     m.whenToTake ? `, ${esc(m.whenToTake)}` : ''
                   }${m.durationDays ? ` for ${esc(m.durationDays)} days` : ''}`
               )
             )}`
           : ''
       }
       ${
         d.followUpSteps?.length
           ? `<h2 style="font-size:15px;margin:20px 0 8px">What to do next</h2>${list(d.followUpSteps.map(esc))}`
           : ''
       }
       ${button(`${env.clientUrl}/appointments/${d.appointmentId}`, 'View full summary')}`,
      'This summary is a plain-language version of your doctor\'s notes. It is not a substitute for medical advice — contact the clinic with any questions.'
    ),
    text: d.patientSummary
  }),

  MEDICATION_REMINDER: (d) => ({
    subject: `Time for your ${d.medicationName}`,
    html: layout(
      'Medicine reminder',
      `${p(`Hello ${esc(d.patientName)}, it is time to take your medicine.`)}
       ${factTable([
         ['Medicine', esc(d.medicationName)],
         ['Dose', esc(d.dosage || 'As prescribed')],
         d.instruction ? ['Instructions', esc(d.instruction)] : null
       ])}
       ${p('Finish the full course even if you feel better.')}`,
      'You are receiving this because your doctor prescribed this medicine at your recent visit.'
    ),
    text: `Time to take ${d.medicationName} (${d.dosage || 'as prescribed'}).`
  }),

  WELCOME: (d) => ({
    subject: `Welcome to ${env.appName}`,
    html: layout(
      `Welcome, ${esc(d.fullName)}`,
      `${p('Your account is ready. You can search doctors by specialisation and book a slot in a couple of minutes.')}
       ${button(`${env.clientUrl}/doctors`, 'Find a doctor')}`
    ),
    text: `Welcome to ${env.appName}, ${d.fullName}.`
  })
};

export const renderTemplate = (name, payload) => {
  const fn = templates[name];
  if (!fn) throw new Error(`Unknown email template: ${name}`);
  return fn(payload || {});
};
