import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../logger';

declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      log: Logger;
    }
  }
}

/** Accept a client-supplied request id only if it is short and log-safe. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Sent by the /health supplier probes so their requests are logged quietly. */
export const HEALTH_PROBE_HEADER = 'X-Health-Probe';

const QUIET_PATHS = new Set(['/health', '/health/live']);

/**
 * Assigns a request id (honours a safe incoming X-Request-Id), echoes it back,
 * attaches a child logger to res.locals.log, and logs one line when the
 * response finishes: info (<400), warn (4xx), error (5xx).
 *
 * Health traffic (/health, /health/live, and requests carrying X-Health-Probe: 1)
 * is logged at debug whatever the status, so frequent probes cannot flood the
 * logs; /health itself logs status changes.
 */
export function requestLogger(baseLogger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const log = baseLogger.child({ requestId });

    res.locals.requestId = requestId;
    res.locals.log = log;
    res.setHeader('X-Request-Id', requestId);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields = {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      };
      const quiet = QUIET_PATHS.has(req.path) || req.get(HEALTH_PROBE_HEADER) === '1';
      if (quiet) log.debug(fields, 'request completed');
      else if (res.statusCode >= 500) log.error(fields, 'request completed');
      else if (res.statusCode >= 400) log.warn(fields, 'request completed');
      else log.info(fields, 'request completed');
    });

    next();
  };
}
