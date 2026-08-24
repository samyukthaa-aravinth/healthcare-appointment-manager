import { env, isLlmConfigured } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Every function here returns a result object, never throws:
 *   { status: 'OK' | 'FALLBACK', data, model, error }
 * A failed LLM call must never fail a booking or a visit note. Callers persist
 * `status` so the UI can label AI output honestly.
 */

const RED_FLAGS = [
  'chest pain', 'chest tightness', 'shortness of breath', "can't breathe", 'cannot breathe',
  'difficulty breathing', 'unconscious', 'fainted', 'seizure', 'stroke', 'slurred speech',
  'severe bleeding', 'coughing blood', 'blood in stool', 'vomiting blood', 'suicidal',
  'numbness on one side', 'paralysis', 'severe abdominal pain', 'high fever', 'stiff neck',
  'allergic reaction', 'swollen throat', 'head injury', 'poisoning', 'overdose'
];

const MODERATE_FLAGS = [
  'fever', 'persistent', 'vomiting', 'diarrhoea', 'diarrhea', 'dizzy', 'dizziness', 'migraine',
  'palpitations', 'swelling', 'infection', 'rash spreading', 'weight loss', 'blurred vision',
  'ear pain', 'dehydrated', 'wheezing', 'injury', 'sprain', 'burn'
];

const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extracts the first JSON object from a model response, tolerating fences/preamble. */
export const extractJson = (text) => {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
};

async function callAnthropic({ system, user, maxTokens = 1200 }) {
  const attempts = env.llm.maxRetries + 1;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.llm.timeoutMs);
    try {
      const res = await fetch(`${env.llm.baseUrl}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.llm.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: env.llm.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }]
        })
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 4xx other than 429 will not succeed on retry — fail fast.
        if (res.status !== 429 && res.status < 500) {
          throw Object.assign(new Error(`LLM ${res.status}: ${truncate(body, 200)}`), { fatal: true });
        }
        throw new Error(`LLM ${res.status}: ${truncate(body, 200)}`);
      }

      const json = await res.json();
      const text = (json.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (!text) throw new Error('LLM returned an empty response');
      return { text, model: json.model || env.llm.model };
    } catch (err) {
      lastError = err;
      if (err.fatal || attempt === attempts) break;
      await sleep(500 * 2 ** (attempt - 1)); // 500ms, 1s
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('LLM call failed');
}

/* ------------------------------------------------------------------ */
/* Pre-visit triage                                                    */
/* ------------------------------------------------------------------ */

const PREVISIT_SYSTEM = `You are a clinical intake assistant for a hospital scheduling system.
You do NOT diagnose and you do NOT recommend treatment. You summarise what the patient reported so the doctor can prepare.
Return ONLY a JSON object, no prose and no markdown fences, with exactly these keys:
{
  "urgency": "Low" | "Medium" | "High",
  "chiefComplaint": string (max 120 chars, the single main problem in clinical shorthand),
  "suggestedQuestions": [string, string, string] (three questions the DOCTOR should ask the patient),
  "keyPoints": [string] (up to 4 short factual bullets: onset, severity, relevant history, medications)
}
Urgency rules: High = red-flag symptoms needing same-day or emergency review (chest pain, breathing difficulty, neurological deficit, severe bleeding, altered consciousness).
Medium = persistent, worsening, or systemic symptoms that should be seen soon.
Low = mild, stable, routine or follow-up concerns.
If the information is too thin to judge, choose Medium and say so in keyPoints.`;

export const buildPreVisitPrompt = (report) => {
  const lines = [
    `Symptoms: ${report.symptomsText}`,
    report.durationDays != null ? `Duration: ${report.durationDays} day(s)` : null,
    report.severity != null ? `Patient-rated severity: ${report.severity}/10` : null,
    report.existingConditions ? `Existing conditions: ${report.existingConditions}` : null,
    report.currentMedications ? `Current medications: ${report.currentMedications}` : null,
    report.allergies ? `Allergies: ${report.allergies}` : null
  ].filter(Boolean);
  return `Analyse these symptoms and return urgency level (Low / Medium / High), chief complaint, and three suggested questions for the doctor.\n\n${lines.join('\n')}`;
};

/** Keyword triage used when the LLM is unavailable. Deliberately cautious. */
export const fallbackTriage = (report) => {
  const text = [
    report.symptomsText,
    report.existingConditions,
    report.currentMedications
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const hits = RED_FLAGS.filter((f) => text.includes(f));
  const moderate = MODERATE_FLAGS.filter((f) => text.includes(f));
  const severity = Number(report.severity) || 0;
  const duration = Number(report.durationDays) || 0;

  let urgency = 'LOW';
  if (hits.length || severity >= 8) urgency = 'HIGH';
  else if (moderate.length || severity >= 5 || duration >= 14) urgency = 'MEDIUM';

  const chiefComplaint = truncate(report.symptomsText.split(/[.\n]/)[0].trim(), 120) || 'Consultation';

  return {
    urgency,
    chiefComplaint,
    suggestedQuestions: [
      'When did the symptoms start and have they changed since?',
      'What makes the symptoms better or worse?',
      'Any fever, weight loss, or other symptoms alongside this?'
    ],
    keyPoints: [
      duration ? `Reported duration: ${duration} day(s).` : 'Duration not provided.',
      severity ? `Self-rated severity ${severity}/10.` : 'Severity not rated.',
      hits.length ? `Possible red-flag wording: ${hits.slice(0, 3).join(', ')}.` : 'No red-flag keywords detected.',
      'Automated keyword triage — AI summary was unavailable, please read the full symptom text.'
    ]
  };
};

const normaliseUrgency = (value) => {
  const v = String(value || '').trim().toUpperCase();
  return ['LOW', 'MEDIUM', 'HIGH'].includes(v) ? v : null;
};

export async function generatePreVisitSummary(report) {
  const fallback = fallbackTriage(report);
  if (!isLlmConfigured()) {
    return { status: 'FALLBACK', data: fallback, error: 'ANTHROPIC_API_KEY is not set' };
  }

  try {
    const { text, model } = await callAnthropic({
      system: PREVISIT_SYSTEM,
      user: buildPreVisitPrompt(report),
      maxTokens: 800
    });
    const parsed = extractJson(text);
    const urgency = normaliseUrgency(parsed?.urgency);
    if (!parsed || !urgency || !parsed.chiefComplaint) {
      throw new Error('LLM response did not match the expected shape');
    }

    const questions = Array.isArray(parsed.suggestedQuestions)
      ? parsed.suggestedQuestions.filter((q) => typeof q === 'string').slice(0, 3)
      : [];

    return {
      status: 'OK',
      model,
      data: {
        urgency,
        chiefComplaint: truncate(String(parsed.chiefComplaint), 200),
        suggestedQuestions: questions.length === 3 ? questions : fallback.suggestedQuestions,
        keyPoints: Array.isArray(parsed.keyPoints)
          ? parsed.keyPoints.filter((k) => typeof k === 'string').slice(0, 4)
          : []
      }
    };
  } catch (err) {
    logger.warn('Pre-visit LLM failed, using fallback triage', { error: err.message });
    return { status: 'FALLBACK', data: fallback, error: truncate(err.message, 300) };
  }
}

/* ------------------------------------------------------------------ */
/* Post-visit patient summary                                          */
/* ------------------------------------------------------------------ */

const POSTVISIT_SYSTEM = `You rewrite doctors' clinical notes into plain language a patient can act on.
Rules: no new medical advice, no dosages the doctor did not write, no diagnosis the doctor did not state.
Read at roughly a 10-year-old reading level. Warm, direct, no jargon; if a medical term must appear, explain it in the same sentence.
Return ONLY a JSON object, no prose and no markdown fences:
{
  "patientSummary": string (2-4 short paragraphs, plain text with \\n\\n between paragraphs),
  "medicationSchedule": [{ "name": string, "dosage": string, "whenToTake": string, "durationDays": number|null, "note": string }],
  "followUpSteps": [string] (concrete next actions, including when to come back and when to seek urgent care)
}
Copy medication names and dosages exactly as written by the doctor.`;

export const buildPostVisitPrompt = ({ clinicalNotes, diagnosis, prescriptions, followUpNotes, followUpAt }) => {
  const meds = (prescriptions || [])
    .map(
      (m) =>
        `- ${m.name}${m.dosage ? ` ${m.dosage}` : ''}${m.frequency ? `, ${m.frequency}` : ''}${
          m.durationDays ? ` for ${m.durationDays} days` : ''
        }${m.instructions ? ` (${m.instructions})` : ''}`
    )
    .join('\n');

  return `Convert these clinical notes into a patient-friendly summary with medication schedule and follow-up steps.

Clinical notes: ${clinicalNotes}
${diagnosis ? `Diagnosis: ${diagnosis}` : ''}
${meds ? `Prescription:\n${meds}` : 'Prescription: none'}
${followUpAt ? `Follow-up date: ${new Date(followUpAt).toDateString()}` : ''}
${followUpNotes ? `Follow-up notes: ${followUpNotes}` : ''}`.trim();
};

export const fallbackPostVisit = ({ clinicalNotes, diagnosis, prescriptions, followUpAt, followUpNotes }) => {
  const meds = (prescriptions || []).map((m) => ({
    name: m.name,
    dosage: m.dosage || '',
    whenToTake: m.frequency || 'As advised by your doctor',
    durationDays: m.durationDays ?? null,
    note: m.instructions || ''
  }));

  const steps = [];
  if (followUpAt) steps.push(`Book your follow-up visit around ${new Date(followUpAt).toDateString()}.`);
  if (followUpNotes) steps.push(followUpNotes);
  steps.push('Finish the full course of every medicine, even if you start feeling better.');
  steps.push('If your symptoms get worse or you feel much more unwell, contact the clinic or seek urgent care.');

  return {
    patientSummary: `${diagnosis ? `Your doctor's assessment: ${diagnosis}.\n\n` : ''}Notes from your visit:\n\n${clinicalNotes}\n\nThis is your doctor's original wording — the plain-language rewrite could not be generated. Please ask the clinic if anything here is unclear.`,
    medicationSchedule: meds,
    followUpSteps: steps
  };
};

export async function generatePostVisitSummary(note) {
  const fallback = fallbackPostVisit(note);
  if (!isLlmConfigured()) {
    return { status: 'FALLBACK', data: fallback, error: 'ANTHROPIC_API_KEY is not set' };
  }

  try {
    const { text, model } = await callAnthropic({
      system: POSTVISIT_SYSTEM,
      user: buildPostVisitPrompt(note),
      maxTokens: 1600
    });
    const parsed = extractJson(text);
    if (!parsed?.patientSummary) throw new Error('LLM response did not match the expected shape');

    return {
      status: 'OK',
      model,
      data: {
        patientSummary: String(parsed.patientSummary),
        medicationSchedule: Array.isArray(parsed.medicationSchedule)
          ? parsed.medicationSchedule
          : fallback.medicationSchedule,
        followUpSteps: Array.isArray(parsed.followUpSteps) ? parsed.followUpSteps : fallback.followUpSteps
      }
    };
  } catch (err) {
    logger.warn('Post-visit LLM failed, using original notes', { error: err.message });
    return { status: 'FALLBACK', data: fallback, error: truncate(err.message, 300) };
  }
}
