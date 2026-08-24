import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

export const notFoundHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details }
    });
  }
  if (err?.code === 'P2002') {
    return res.status(409).json({
      error: { code: 'DUPLICATE', message: 'That record already exists.' }
    });
  }
  if (err?.code === 'P2025') {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  }

  logger.error('Unhandled error', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Something broke on our side. Try again in a moment.',
      ...(env.nodeEnv === 'development' ? { debug: err.message } : {})
    }
  });
};
