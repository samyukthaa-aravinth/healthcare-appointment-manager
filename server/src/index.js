import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { startWorker } from './jobs/worker.js';

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info(`${env.appName} API listening on :${env.port}`, {
    env: env.nodeEnv,
    client: env.clientUrl
  });
  if (env.worker.inProcess) startWorker();
});

const shutdown = async (signal) => {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', err));
