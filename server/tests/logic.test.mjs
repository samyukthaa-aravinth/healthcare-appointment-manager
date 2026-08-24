/**
 * Pure-logic tests — no database required.
 *   node --test tests/
 *
 * These cover the parts most likely to break silently: timezone maths in the
 * slot grid, the triage fallback that runs when the LLM is down, and the
 * prescription-to-reminder expansion.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { enumerateSlots } from '../src/services/slot.service.js';
import { fallbackTriage, extractJson, buildPreVisitPrompt, fallbackPostVisit } from '../src/services/llm.service.js';
import { parseFrequency, buildReminderSchedule } from '../src/services/visit.service.js';
import { parseDateOnly, zonedDayOfWeek, zonedDayMinutesToUtc } from '../src/utils/time.js';

describe('time helpers', () => {
  test('parses YYYY-MM-DD to UTC midnight', () => {
    assert.equal(parseDateOnly('2026-09-01').toISOString(), '2026-09-01T00:00:00.000Z');
  });
  test('rejects other date formats', () => {
    assert.equal(parseDateOnly('01/09/2026'), null);
  });
  test('resolves weekday in the doctor timezone', () => {
    assert.equal(zonedDayOfWeek(parseDateOnly('2026-09-01'), 'Asia/Kolkata'), 2); // Tuesday
  });
  test('converts local clock time to the right UTC instant', () => {
    assert.equal(
      zonedDayMinutesToUtc(parseDateOnly('2026-09-01'), 9 * 60, 'Asia/Kolkata').toISOString(),
      '2026-09-01T03:30:00.000Z'
    );
  });
  test('respects daylight saving on both sides of the switch', () => {
    assert.equal(
      zonedDayMinutesToUtc(parseDateOnly('2026-07-01'), 9 * 60, 'America/New_York').toISOString(),
      '2026-07-01T13:00:00.000Z'
    );
    assert.equal(
      zonedDayMinutesToUtc(parseDateOnly('2026-01-15'), 9 * 60, 'America/New_York').toISOString(),
      '2026-01-15T14:00:00.000Z'
    );
  });
});

describe('slot generation', () => {
  const doctor = {
    id: 'd1',
    timezone: 'Asia/Kolkata',
    slotDurationMinutes: 20,
    bufferMinutes: 5,
    workingHours: [{ dayOfWeek: 2, startMinute: 9 * 60, endMinute: 11 * 60 }]
  };

  test('honours duration plus buffer', () => {
    const slots = enumerateSlots(doctor, parseDateOnly('2026-09-01'));
    assert.equal(slots.length, 5);
    assert.equal(slots[1].startsAt - slots[0].startsAt, 25 * 60000);
  });
  test('never produces a slot that overruns the window', () => {
    const slots = enumerateSlots(doctor, parseDateOnly('2026-09-01'));
    const windowEnd = zonedDayMinutesToUtc(parseDateOnly('2026-09-01'), 11 * 60, 'Asia/Kolkata');
    assert.ok(slots.every((s) => s.endsAt <= windowEnd));
  });
  test('returns nothing on a day the doctor does not work', () => {
    assert.equal(enumerateSlots(doctor, parseDateOnly('2026-09-02')).length, 0);
  });
  test('does not loop forever on a zero-length slot', () => {
    const broken = { ...doctor, slotDurationMinutes: 0, bufferMinutes: 0 };
    assert.equal(enumerateSlots(broken, parseDateOnly('2026-09-01')).length, 0);
  });
});

describe('triage fallback (LLM unavailable)', () => {
  test('escalates red-flag wording to HIGH', () => {
    assert.equal(fallbackTriage({ symptomsText: 'Crushing chest pain since morning' }).urgency, 'HIGH');
  });
  test('escalates on self-rated severity', () => {
    assert.equal(fallbackTriage({ symptomsText: 'headache', severity: 9 }).urgency, 'HIGH');
  });
  test('flags persistent symptoms as MEDIUM', () => {
    assert.equal(fallbackTriage({ symptomsText: 'fever for three days' }).urgency, 'MEDIUM');
  });
  test('leaves mild complaints LOW', () => {
    assert.equal(fallbackTriage({ symptomsText: 'small cut on finger', severity: 2 }).urgency, 'LOW');
  });
  test('always returns exactly three questions', () => {
    assert.equal(fallbackTriage({ symptomsText: 'cough' }).suggestedQuestions.length, 3);
  });
  test('prompt carries the symptom detail through', () => {
    const prompt = buildPreVisitPrompt({ symptomsText: 'sore throat', durationDays: 3 });
    assert.match(prompt, /sore throat/);
    assert.match(prompt, /3 day/);
  });
});

describe('LLM response parsing', () => {
  test('reads a bare JSON object', () => {
    assert.equal(extractJson('{"urgency":"High"}').urgency, 'High');
  });
  test('reads JSON inside markdown fences', () => {
    assert.equal(extractJson('```json\n{"urgency":"Low"}\n```').urgency, 'Low');
  });
  test('reads JSON after a chatty preamble', () => {
    assert.equal(extractJson('Sure!\n{"urgency":"Medium"}').urgency, 'Medium');
  });
  test('returns null rather than throwing on garbage', () => {
    assert.equal(extractJson('no json at all'), null);
    assert.equal(extractJson(''), null);
  });
});

describe('prescription frequency parsing', () => {
  const cases = [
    ['1-0-1', 'TWICE_DAILY'],
    ['1-1-1', 'THRICE_DAILY'],
    ['1-0-0', 'ONCE_DAILY'],
    ['BD', 'TWICE_DAILY'],
    ['TDS', 'THRICE_DAILY'],
    ['SOS', 'AS_NEEDED'],
    ['twice daily', 'TWICE_DAILY'],
    ['whenever', 'ONCE_DAILY']
  ];
  for (const [input, expected] of cases) {
    test(`${input} -> ${expected}`, () => assert.equal(parseFrequency(input), expected));
  }
});

describe('medication reminder schedule', () => {
  const meds = [{ name: 'Amoxicillin', dosage: '500mg', frequency: '1-0-1', durationDays: 5 }];

  test('expands to two doses a day', () => {
    const rows = buildReminderSchedule({ prescriptions: meds, from: new Date(), timezone: 'Asia/Kolkata' });
    assert.ok(rows.length >= 8 && rows.length <= 10);
  });
  test('schedules doses at the right local clock times', () => {
    const rows = buildReminderSchedule({ prescriptions: meds, from: new Date(), timezone: 'Asia/Kolkata' });
    const hours = new Set(
      rows.map((r) =>
        new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(
          r.scheduledFor
        )
      )
    );
    assert.deepEqual([...hours].sort(), ['09', '21']);
  });
  test('never schedules a dose in the past', () => {
    const rows = buildReminderSchedule({ prescriptions: meds, from: new Date() });
    assert.ok(rows.every((r) => r.scheduledFor > new Date()));
  });
  test('skips as-needed medicines', () => {
    const rows = buildReminderSchedule({
      prescriptions: [{ name: 'X', frequency: 'SOS', durationDays: 5 }],
      from: new Date()
    });
    assert.equal(rows.length, 0);
  });
  test('caps an absurd duration instead of flooding the table', () => {
    const rows = buildReminderSchedule({
      prescriptions: [{ name: 'X', frequency: '1-1-1', durationDays: 900 }],
      from: new Date()
    });
    assert.ok(rows.length <= 60);
  });
});

describe('post-visit fallback', () => {
  const fb = fallbackPostVisit({
    clinicalNotes: 'URTI, rest advised',
    diagnosis: 'Viral URTI',
    prescriptions: [{ name: 'Paracetamol', dosage: '650mg', frequency: '1-0-1', durationDays: 3 }]
  });
  test("keeps the doctor's own wording rather than inventing text", () => {
    assert.match(fb.patientSummary, /URTI, rest advised/);
  });
  test('still carries the medication list', () => {
    assert.equal(fb.medicationSchedule[0].name, 'Paracetamol');
  });
  test('still gives follow-up steps', () => {
    assert.ok(fb.followUpSteps.length >= 2);
  });
});
