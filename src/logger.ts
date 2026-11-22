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

/**
 * Process-level safety net for entrypoints: an unhandled rejection or uncaught
 * exception is logged as one structured fatal line (instead of a raw stack on
 * stderr) and the process exits 1, since its state can no longer be trusted.
 */
export function installProcessSafetyNet(log: Logger): void {
  const die = (fields: Record<string, unknown>, msg: string): void => {
    log.fatal(fields, msg);
    log.flush();
    process.exit(1);
  };
  process.on('unhandledRejection', (reason) => die({ err: reason }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err, origin) => die({ err, origin }, 'uncaught exception'));
}

export type { Logger };
