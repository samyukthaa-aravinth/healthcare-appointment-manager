import dotenv from 'dotenv';
dotenv.config();

const bool = (v, d = false) => (v === undefined ? d : String(v).toLowerCase() === 'true');
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  appName: process.env.APP_NAME || 'Meridian Clinic',
  clientUrl: (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, ''),
  serverUrl: (process.env.SERVER_URL || 'http://localhost:4000').replace(/\/$/, ''),

  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@meridian.health',
  adminPassword: process.env.ADMIN_PASSWORD || 'Admin@12345',

  slotHoldMinutes: int(process.env.SLOT_HOLD_MINUTES, 10),
  bookingHorizonDays: int(process.env.BOOKING_HORIZON_DAYS, 30),

  llm: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    baseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
    timeoutMs: int(process.env.LLM_TIMEOUT_MS, 20000),
    maxRetries: int(process.env.LLM_MAX_RETRIES, 2)
  },

  email: {
    transport: process.env.EMAIL_TRANSPORT || 'console',
    from: process.env.EMAIL_FROM || 'Meridian Clinic <no-reply@meridian.health>',
    smtp: {
      host: process.env.SMTP_HOST,
      port: int(process.env.SMTP_PORT, 587),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    sendgridApiKey: process.env.SENDGRID_API_KEY || ''
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/calendar/google/callback'
  },

  worker: {
    inProcess: bool(process.env.RUN_WORKER_IN_PROCESS, true),
    reminderLeadHours: int(process.env.REMINDER_LEAD_HOURS, 24)
  }
};

export const isGoogleConfigured = () => Boolean(env.google.clientId && env.google.clientSecret);
export const isLlmConfigured = () => Boolean(env.llm.apiKey);
