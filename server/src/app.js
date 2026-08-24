import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';

import authRoutes from './routes/auth.routes.js';
import doctorRoutes from './routes/doctor.routes.js';
import appointmentRoutes from './routes/appointment.routes.js';
import adminRoutes from './routes/admin.routes.js';
import calendarRoutes from './routes/calendar.routes.js';
import healthRoutes from './routes/health.routes.js';

export const createApp = () => {
  const app = express();

  app.set('trust proxy', 1); // Render/Railway sit behind a proxy
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(
    cors({
      origin: env.nodeEnv === 'production' ? [env.clientUrl] : true,
      credentials: true
    })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'));
  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false
    })
  );

  app.use('/api/health', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/doctors', doctorRoutes);
  app.use('/api/appointments', appointmentRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/calendar', calendarRoutes);

  app.get('/', (_req, res) =>
    res.json({ name: `${env.appName} API`, docs: '/api/health', version: '1.0.0' })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};
