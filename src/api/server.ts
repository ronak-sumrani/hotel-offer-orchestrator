import { createServer, type Server } from 'node:http';
import express, { type Express } from 'express';
import { config } from '../config';
import { createLogger, installProcessSafetyNet } from '../logger';
import { closeApiRedis, getApiRedis } from '../redis/client';
import { closeTemporalClient } from '../temporal/client';
import { errorHandler, notFoundHandler } from './errors';
import { requestLogger } from './requestLogger';
import { createHealthRouter, type HealthRouterOptions } from './routes/health';
import { createHotelsRouter, type HotelsRouterOptions } from './routes/hotels';
import { createSupplierRouter, type SupplierRouterOptions } from './routes/suppliers';

const log = createLogger('api');

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface AppOptions {
  /** Overrides for the mock supplier routes (tests use this to disable the delay). */
  suppliers?: Partial<SupplierRouterOptions>;
  /** Overrides for /api/hotels (tests inject a fake workflow runner and cache). */
  hotels?: Partial<HotelsRouterOptions>;
  /** Overrides for /health (tests inject fake checks and a short timeout). */
  health?: Partial<HealthRouterOptions>;
}

/**
 * Builds the Express app without listening (used directly by supertest).
 * GET-only API: no body parser is installed.
 */
export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestLogger(log));

  app.use(createHealthRouter(options.health));
  app.use(createSupplierRouter(options.suppliers));
  app.use(createHotelsRouter(options.hotels));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Starts the HTTP server and installs graceful-shutdown handlers. */
export function start(): Server {
  // Connect eagerly: the offline queue is disabled, so a client created on the
  // first request would fail that request while still connecting.
  getApiRedis();
  const app = createApp();
  // Not app.listen(port, cb): Express 5 also registers cb as the 'error'
  // listener, so it would log "API listening" even when listen fails.
  const server = createServer(app);

  server.once('listening', () => {
    log.info({ port: config.port }, 'API listening');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.fatal({ port: config.port }, `port ${config.port} already in use`);
    } else if (err.code === 'EACCES') {
      log.fatal({ port: config.port }, `permission denied to listen on port ${config.port}`);
    } else {
      log.fatal({ err }, 'API server failed');
    }
    process.exit(1);
  });

  server.listen(config.port);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    setTimeout(() => {
      log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    server.close((closeErr) => {
      if (closeErr) log.error({ err: closeErr }, 'error closing HTTP server');
      log.info('closing Temporal and Redis clients');
      Promise.allSettled([
        closeTemporalClient().catch((err: unknown) => log.error({ err }, 'error closing Temporal client')),
        closeApiRedis()
          .then(() => log.info('Redis client closed'))
          .catch((err: unknown) => log.error({ err }, 'error closing Redis client')),
      ]).finally(() => {
        log.info('shutdown complete');
        process.exit(closeErr ? 1 : 0);
      });
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

if (require.main === module) {
  installProcessSafetyNet(log);
  start();
}
