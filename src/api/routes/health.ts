import { Router } from 'express';
import { logger, type Logger } from '../../logger';
import {
  CHECK_NAMES,
  createDefaultChecks,
  ProbeError,
  type CheckName,
  type CheckResult,
  type HealthChecks,
  type HealthStatus,
  type Probe,
} from '../health';

export interface HealthRouterOptions {
  /** Probes per dependency. Default: real suppliers, Redis, Temporal, worker. Tests inject fakes. */
  checks: HealthChecks;
  /** Per-check timeout. Default 1000 ms. */
  timeoutMs: number;
}

export interface HealthBody {
  status: HealthStatus;
  checks: Record<CheckName, CheckResult>;
  timestamp: string;
}

const DEFAULT_TIMEOUT_MS = 1_000;

/**
 * Precedence down > degraded > ok.
 * - down: both suppliers down, Temporal down, or no worker polling.
 * - degraded: exactly one supplier down, and/or Redis down.
 */
export function deriveStatus(r: Record<CheckName, CheckResult>): HealthStatus {
  const down = (name: CheckName): boolean => r[name].status === 'down';
  if ((down('supplierA') && down('supplierB')) || down('temporal') || down('worker')) return 'down';
  if (down('supplierA') || down('supplierB') || down('redis')) return 'degraded';
  return 'ok';
}

/** Runs one probe with a hard timeout. Never throws, never hangs past timeoutMs. */
async function runCheck(name: CheckName, probe: Probe, timeoutMs: number, log: Logger): Promise<CheckResult> {
  const controller = new AbortController();
  const started = performance.now();
  const latencyMs = (): number => Math.round(performance.now() - started);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });

  try {
    // .then() so a probe that throws synchronously still becomes a rejection.
    await Promise.race([Promise.resolve().then(() => probe(controller.signal)), timeout]);
    return { status: 'up', latencyMs: latencyMs() };
  } catch (err) {
    const error = controller.signal.aborted
      ? 'timeout'
      : err instanceof ProbeError
        ? err.publicMessage
        : 'check failed';
    log.debug({ check: name, error, err, latencyMs: latencyMs() }, 'health check failed');
    return { status: 'down', latencyMs: latencyMs(), error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /health       dependency report: 200 ok/degraded, 503 down.
 * GET /health/live  liveness only (no dependency checks), always 200.
 */
export function createHealthRouter(options: Partial<HealthRouterOptions> = {}): Router {
  const checks = options.checks ?? createDefaultChecks();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Logged only on change, so frequent probes don't flood the logs.
  let lastStatus: HealthStatus | undefined;

  const router = Router();

  router.get('/health/live', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });

  router.get('/health', async (_req, res) => {
    const log = res.locals.log ?? logger;
    const results = await Promise.all(
      CHECK_NAMES.map(async (name) => [name, await runCheck(name, checks[name], timeoutMs, log)] as const),
    );
    const body: HealthBody = {
      status: 'ok',
      checks: Object.fromEntries(results) as Record<CheckName, CheckResult>,
      timestamp: new Date().toISOString(),
    };
    body.status = deriveStatus(body.checks);

    if (body.status !== lastStatus) {
      const down = CHECK_NAMES.filter((n) => body.checks[n].status === 'down');
      const fields = { previous: lastStatus ?? null, status: body.status, down };
      if (body.status === 'ok') log.info(fields, 'health status changed');
      else log.warn(fields, 'health status changed');
      lastStatus = body.status;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(body.status === 'down' ? 503 : 200).json(body);
  });

  return router;
}
