import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { config } from '../config';
import { createLogger } from '../logger';
import { errorHandler, notFoundHandler } from './errors';
import { requestLogger } from './requestLogger';
import { createSupplierRouter, type SupplierRouterOptions } from './routes/suppliers';

const log = createLogger('api');

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface AppOptions {
  /** Overrides for the mock supplier routes (tests use this to disable the delay). */
  suppliers?: Partial<SupplierRouterOptions>;
}

/** Builds the Express app without listening (used directly by supertest). */
export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestLogger(log));
  app.use(express.json());

  app.use(createSupplierRouter(options.suppliers));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Starts the HTTP server and installs graceful-shutdown handlers. */
export function start(): Server {
  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info({ port: config.port }, 'API listening');
  });

  server.on('error', (err) => {
    log.fatal({ err }, 'API server failed');
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    server.close((err) => {
      if (err) {
        log.error({ err }, 'error during shutdown');
        process.exit(1);
      }
      log.info('shutdown complete');
      process.exit(0);
    });

    setTimeout(() => {
      log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

if (require.main === module) {
  start();
}
