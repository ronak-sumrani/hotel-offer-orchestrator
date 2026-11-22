import { existsSync } from 'node:fs';
import path from 'node:path';
import type { LogLevel as TemporalLogLevel, LogMetadata, Logger as TemporalLogger } from '@temporalio/common';
import { NativeConnection, Runtime, Worker, type WorkerOptions } from '@temporalio/worker';
import { config } from '../config';
import { createLogger, installProcessSafetyNet, type Logger } from '../logger';
import { closeWorkerRedis, getWorkerRedis } from '../redis/client';
import { createHotelRepository } from '../redis/hotelRepository';
import { createActivities } from './activities';

const log = createLogger('worker');

/** Must match WORKFLOW_BUNDLE_FILENAME in bundleWorkflows.ts (not imported: that module pulls in the bundler). */
const WORKFLOW_BUNDLE_FILENAME = 'workflow-bundle.js';

type WorkflowSource =
  | { kind: 'bundle'; options: Pick<WorkerOptions, 'workflowBundle'>; location: string }
  | { kind: 'path'; options: Pick<WorkerOptions, 'workflowsPath'>; location: string };

/**
 * Compiled run (node dist/...): `npm run build` writes the pre-built bundle next to
 * this file, so the worker skips webpack at startup. Dev (tsx, __dirname = src/temporal):
 * no bundle there, so fall back to workflowsPath and bundle on the fly.
 */
function resolveWorkflowSource(): WorkflowSource {
  const bundlePath = path.join(__dirname, WORKFLOW_BUNDLE_FILENAME);
  if (existsSync(bundlePath)) {
    return { kind: 'bundle', options: { workflowBundle: { codePath: bundlePath } }, location: bundlePath };
  }
  const workflowsPath = require.resolve('./workflows');
  return { kind: 'path', options: { workflowsPath }, location: workflowsPath };
}

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
    const workflowSource = resolveWorkflowSource();
    log.info(
      { workflowSource: workflowSource.kind, location: workflowSource.location },
      'loading workflow code',
    );

    connection = await NativeConnection.connect({ address: config.temporalAddress });
    const worker = await Worker.create({
      connection,
      namespace: config.temporalNamespace,
      taskQueue: config.temporalTaskQueue,
      ...workflowSource.options,
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
        workflowSource: workflowSource.kind,
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
