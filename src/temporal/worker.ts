import type { LogLevel as TemporalLogLevel, LogMetadata, Logger as TemporalLogger } from '@temporalio/common';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { config } from '../config';
import { createLogger, installProcessSafetyNet, type Logger } from '../logger';
import { closeWorkerRedis, getWorkerRedis } from '../redis/client';
import { createHotelRepository } from '../redis/hotelRepository';
import { createActivities } from './activities';

const log = createLogger('worker');

/** Routes Temporal SDK + activity-context logs through pino. */
function pinoTemporalLogger(pino: Logger): TemporalLogger {
  const write = (level: TemporalLogLevel, message: string, meta?: LogMetadata): void => {
    const method = level.toLowerCase() as 'trace' | 'debug' | 'info' | 'warn' | 'error';
    pino[method](meta ?? {}, message);
  };
  return {
    log: write,
    trace: (m, meta) => write('TRACE', m, meta),
    debug: (m, meta) => write('DEBUG', m, meta),
    info: (m, meta) => write('INFO', m, meta),
    warn: (m, meta) => write('WARN', m, meta),
    error: (m, meta) => write('ERROR', m, meta),
  };
}

/**
 * Starts the worker and resolves once it has shut down.
 * Graceful shutdown: Temporal's Runtime handles SIGINT/SIGTERM itself (default
 * shutdownSignals): it stops polling, lets in-flight activities finish within
 * shutdownGraceTime, then worker.run() resolves.
 */
export async function runWorker(): Promise<void> {
  Runtime.install({
    logger: pinoTemporalLogger(log.child({ component: 'temporal' })),
    // Forward native (Rust core) logs to the same pino logger instead of raw console output.
    telemetryOptions: { logging: { filter: { core: 'WARN', other: 'ERROR' }, forward: {} } },
  });

  // Connect eagerly: with the offline queue disabled, a client created on the
  // first saveToRedis call would fail that call while still connecting.
  getWorkerRedis();

  let connection: NativeConnection | undefined;
  try {
    connection = await NativeConnection.connect({ address: config.temporalAddress });
    const worker = await Worker.create({
      connection,
      namespace: config.temporalNamespace,
      taskQueue: config.temporalTaskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities: createActivities({
        supplierBaseUrl: config.supplierBaseUrl,
        hotelStore: createHotelRepository({
          getClient: getWorkerRedis,
          ttlSeconds: config.cacheTtlSeconds,
          partialTtlSeconds: config.partialCacheTtlSeconds,
          log,
        }),
      }),
      shutdownGraceTime: '10s',
    });

    log.info(
      {
        address: config.temporalAddress,
        namespace: config.temporalNamespace,
        taskQueue: config.temporalTaskQueue,
        supplierBaseUrl: config.supplierBaseUrl,
      },
      'worker started',
    );
    await worker.run();
    log.info('worker stopped');
  } finally {
    // Cleanup errors are logged, never thrown, so they cannot mask the original error.
    log.info('closing Redis client');
    await closeWorkerRedis().then(
      () => log.info('Redis client closed'),
      (err: unknown) => log.error({ err }, 'error closing Redis client'),
    );
    await connection
      ?.close()
      .catch((err: unknown) => log.error({ err }, 'error closing Temporal connection'));
  }
}

if (require.main === module) {
  installProcessSafetyNet(log);
  runWorker().catch((err: unknown) => {
    log.fatal({ err }, 'worker failed');
    process.exitCode = 1;
  });
}
