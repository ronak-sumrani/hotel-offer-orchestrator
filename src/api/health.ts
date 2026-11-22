/**
 * Health probes behind GET /health. A probe resolves when its dependency is up
 * and throws when it is down. Only a ProbeError's publicMessage is ever shown
 * to clients; every other error is reported as "check failed" (details are
 * logged, never returned).
 */
import { config } from '../config';
import { getApiRedis } from '../redis/client';
import { countWorkerPollers, pingTemporal } from '../temporal/health';
import { HEALTH_PROBE_HEADER } from './requestLogger';

export const CHECK_NAMES = ['supplierA', 'supplierB', 'redis', 'temporal', 'worker'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** Resolves = up, throws = down. Must honour the signal (aborted on timeout). */
export type Probe = (signal: AbortSignal) => Promise<void>;
export type HealthChecks = Record<CheckName, Probe>;

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface CheckResult {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

/** A failure whose publicMessage is safe to return to clients (no hosts, ports, stacks). */
export class ProbeError extends Error {
  constructor(
    readonly publicMessage: string,
    options?: ErrorOptions,
  ) {
    super(publicMessage, options);
    this.name = 'ProbeError';
  }
}

const GRPC_NOT_FOUND = 5;

function supplierProbe(path: string): Probe {
  return async (signal) => {
    let res: Response;
    try {
      res = await fetch(`${config.supplierBaseUrl}${path}?city=delhi`, {
        signal,
        headers: { [HEALTH_PROBE_HEADER]: '1' },
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ProbeError('unreachable', { cause: err });
    }
    // Always drain/release the body so the socket goes back to the pool.
    await res.body?.cancel().catch(() => {});
    if (!res.ok) throw new ProbeError(`HTTP ${res.status}`);
  };
}

async function redisProbe(): Promise<void> {
  try {
    await getApiRedis().ping();
  } catch (err) {
    throw new ProbeError('unreachable', { cause: err });
  }
}

function temporalErrorMessage(err: unknown): string {
  return (err as { code?: unknown })?.code === GRPC_NOT_FOUND ? 'namespace not found' : 'unreachable';
}

async function temporalProbe(signal: AbortSignal): Promise<void> {
  try {
    await pingTemporal(signal);
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ProbeError(temporalErrorMessage(err), { cause: err });
  }
}

async function workerProbe(signal: AbortSignal): Promise<void> {
  let pollers;
  try {
    pollers = await countWorkerPollers(signal);
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ProbeError(`temporal ${temporalErrorMessage(err)}`, { cause: err });
  }
  if (pollers.workflow === 0 || pollers.activity === 0) {
    throw new ProbeError('no worker polling task queue');
  }
}

/** Real probes. Creating them opens no connections; each runs only when called. */
export function createDefaultChecks(): HealthChecks {
  return {
    supplierA: supplierProbe('/supplierA/hotels'),
    supplierB: supplierProbe('/supplierB/hotels'),
    redis: redisProbe,
    temporal: temporalProbe,
    worker: workerProbe,
  };
}
