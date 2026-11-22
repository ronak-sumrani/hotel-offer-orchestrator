import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CHECK_NAMES, ProbeError, type CheckName, type HealthChecks, type Probe } from '../src/api/health';
import { createApp } from '../src/api/server';
import type { RunHotelOffers } from '../src/temporal/runner';

const up: Probe = async () => {};
const down =
  (message = 'HTTP 500'): Probe =>
  async () => {
    throw new ProbeError(message);
  };
/** Never settles on its own; only the health timeout can end it. */
const hang: Probe = () => new Promise<void>(() => {});

const TIMEOUT_MS = 50;

function appWith(overrides: Partial<HealthChecks> = {}) {
  const checks: HealthChecks = {
    supplierA: up,
    supplierB: up,
    redis: up,
    temporal: up,
    worker: up,
    ...overrides,
  };
  return createApp({
    suppliers: { delay: async () => {} },
    hotels: {
      runHotelOffers: (async () => {
        throw new Error('not used');
      }) as RunHotelOffers,
      hotelCache: { findByPriceRange: async () => null },
    },
    health: { checks, timeoutMs: TIMEOUT_MS },
  });
}

function statuses(body: { checks: Record<CheckName, { status: string }> }): Record<string, string> {
  return Object.fromEntries(CHECK_NAMES.map((n) => [n, body.checks[n].status]));
}

describe('GET /health: status rules', () => {
  it.each<[string, Partial<HealthChecks>, number, string]>([
    ['all up', {}, 200, 'ok'],
    ['supplier A down', { supplierA: down() }, 200, 'degraded'],
    ['supplier B down', { supplierB: down() }, 200, 'degraded'],
    ['redis down', { redis: down('unreachable') }, 200, 'degraded'],
    ['one supplier + redis down', { supplierA: down(), redis: down('unreachable') }, 200, 'degraded'],
    ['both suppliers down', { supplierA: down(), supplierB: down() }, 503, 'down'],
    ['temporal down', { temporal: down('unreachable') }, 503, 'down'],
    ['worker down', { worker: down('no worker polling task queue') }, 503, 'down'],
    ['worker down + supplier down', { worker: down('no worker polling task queue'), supplierB: down() }, 503, 'down'],
  ])('%s → %i %s', async (_label, overrides, httpStatus, status) => {
    const res = await request(appWith(overrides)).get('/health');
    expect(res.status).toBe(httpStatus);
    expect(res.body.status).toBe(status);
    expect(res.headers['cache-control']).toBe('no-store');
    for (const name of CHECK_NAMES) {
      expect(res.body.checks[name].status).toBe(name in overrides ? 'down' : 'up');
    }
  });

  it('response shape: every check has status + numeric latencyMs; ISO timestamp', async () => {
    const res = await request(appWith({ supplierB: down() })).get('/health');
    expect(Object.keys(res.body.checks).sort()).toEqual([...CHECK_NAMES].sort());
    for (const name of CHECK_NAMES) {
      expect(typeof res.body.checks[name].latencyMs).toBe('number');
    }
    expect(res.body.checks.supplierA).not.toHaveProperty('error');
    expect(res.body.checks.supplierB.error).toBe('HTTP 500');
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  });
});

describe('GET /health: failure handling', () => {
  it('a hanging check is reported down with "timeout" and does not delay the response', async () => {
    const started = performance.now();
    const res = await request(appWith({ redis: hang })).get('/health');
    const elapsed = performance.now() - started;

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.redis).toMatchObject({ status: 'down', error: 'timeout' });
    expect(res.body.checks.redis.latencyMs).toBeGreaterThanOrEqual(TIMEOUT_MS - 5);
    expect(elapsed).toBeLessThan(500);
  });

  it('the probe receives a signal that is aborted on timeout', async () => {
    let signal: AbortSignal | undefined;
    const probe: Probe = (s) => {
      signal = s;
      return new Promise<void>(() => {});
    };
    await request(appWith({ worker: probe })).get('/health');
    expect(signal?.aborted).toBe(true);
  });

  it('a probe that throws synchronously is reported down, not a 500', async () => {
    const throwsSync: Probe = () => {
      throw new Error('boom');
    };
    const res = await request(appWith({ supplierA: throwsSync })).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.checks.supplierA).toMatchObject({ status: 'down', error: 'check failed' });
  });

  it('internal error details never reach the response', async () => {
    const leaky: Probe = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:6379');
    };
    const res = await request(appWith({ redis: leaky, temporal: leaky })).get('/health');
    expect(res.body.checks.redis.error).toBe('check failed');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|6379/);
  });

  it('all checks run in parallel', async () => {
    const slow: Probe = () => new Promise<void>((r) => setTimeout(r, 30));
    const app = createApp({
      health: {
        checks: { supplierA: slow, supplierB: slow, redis: slow, temporal: slow, worker: slow },
        timeoutMs: 200,
      },
      hotels: { runHotelOffers: (async () => ({}) as never) as RunHotelOffers, hotelCache: { findByPriceRange: async () => null } },
    });
    const started = performance.now();
    const res = await request(app).get('/health');
    expect(statuses(res.body)).toEqual(Object.fromEntries(CHECK_NAMES.map((n) => [n, 'up'])));
    expect(performance.now() - started).toBeLessThan(5 * 30);
  });
});

describe('GET /health/live', () => {
  it('is always 200 {status:"ok"}, even when every dependency is down', async () => {
    const allDown = Object.fromEntries(CHECK_NAMES.map((n) => [n, down()])) as HealthChecks;
    const res = await request(appWith(allDown)).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
