import pino, { type Logger } from 'pino';
import { config } from './config';

/** Root logger. Always emits JSON; pipe through pino-pretty for readable dev output. */
export const logger: Logger = pino({
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Child logger tagged with the process role, e.g. "api" or "worker". */
export function createLogger(service: string): Logger {
  return logger.child({ service });
}

export type { Logger };
