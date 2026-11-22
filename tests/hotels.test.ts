import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/api/server';
import type { BestOffer } from '../src/domain/types';
import { CacheUnavailableError, type CachedOffers, type HotelCache } from '../src/redis/hotelRepository';
import {
  AllSuppliersFailedError,
  TemporalUnavailableError,
  WorkflowTimeoutError,
  type RunHotelOffers,
} from '../src/temporal/runner';
import type { HotelOffersResult } from '../src/temporal/shared';

const OFFERS: BestOffer[] = [
  { name: 'Lemon Tree', price: 3200, supplier: 'Supplier A', commissionPct: 8 },
  { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
  { name: 'ITC Maurya', price: 8800, supplier: 'Supplier B', commissionPct: 15 },
];

/** In-memory stand-in for Redis. Filtering here is test-only; src/ never filters prices. */
class FakeCache implements HotelCache {
  data = new Map<string, CachedOffers>();
  down = false;
  calls = 0;

  async findByPriceRange(city: string, min?: number, max?: number): Promise<CachedOffers | null> {
    this.calls += 1;
    if (this.down) throw new CacheUnavailableError('fake redis down');
    const entry = this.data.get(city);
    if (!entry) return null;
    return {
      offers: entry.offers.filter((o) => (min === undefined || o.price >= min) && (max === undefined || o.price <= max)),
      failedSuppliers: entry.failedSuppliers,
    };
  }
}

const runner = vi.fn<RunHotelOffers>();
const cache = new FakeCache();
const app = createApp({
  suppliers: { delay: async () => {} },
  hotels: { runHotelOffers: runner, hotelCache: cache },
});

/**
 * Fake workflow run. Like the real worker, it writes to the cache when
 * cached is true (default: offers non-empty); `save: false` simulates a
 * read-back miss.
 */
function resolveWith(
  partial: Omit<HotelOffersResult, 'cached'> & { cached?: boolean },
  { save = true }: { save?: boolean } = {},
): void {
  const result: HotelOffersResult = { cached: partial.offers.length > 0, ...partial };
  runner.mockImplementation(async ({ city }) => {
    if (result.cached && save) {
      cache.data.set(city, { offers: result.offers, failedSuppliers: result.failedSuppliers });
    }
    return result;
  });
}

beforeEach(() => {
  runner.mockReset();
  cache.data.clear();
  cache.down = false;
  cache.calls = 0;
  resolveWith({ offers: OFFERS, failedSuppliers: [] });
});

describe('GET /api/hotels: success', () => {
  it('returns the bare array in order with exactly the response fields', async () => {
    // Extra field from the workflow must not leak into the response.
    resolveWith({
      offers: OFFERS.map((o) => ({ ...o, hotelId: 'x' }) as BestOffer),
      failedSuppliers: [],
    });

    const res = await request(app).get('/api/hotels?city=delhi');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(OFFERS);
    for (const item of res.body) {
      expect(Object.keys(item).sort()).toEqual(['commissionPct', 'name', 'price', 'supplier']);
    }
    expect(res.headers['x-failed-suppliers']).toBeUndefined();
  });

  it('normalizes city and uses workflowId hotel-offers-{city}-{uuid}', async () => {
    const res = await request(app).get('/api/hotels?city=%20DeLhI%20');

    expect(res.status).toBe(200);
    expect(runner).toHaveBeenCalledTimes(1);
    const [input, opts] = runner.mock.calls[0]!;
    expect(input).toEqual({ city: 'delhi' });
    expect(opts.workflowId).toMatch(/^hotel-offers-delhi-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('sets X-Failed-Suppliers when one supplier failed', async () => {
    resolveWith({ offers: OFFERS.slice(1), failedSuppliers: ['Supplier A'] });

    const res = await request(app).get('/api/hotels?city=delhi');

    expect(res.status).toBe(200);
    expect(res.headers['x-failed-suppliers']).toBe('Supplier A');
    expect(res.body).toEqual(OFFERS.slice(1));
  });

  it('returns 200 [] for an empty result', async () => {
    resolveWith({ offers: [], failedSuppliers: [] });
    const res = await request(app).get('/api/hotels?city=goa');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each([
    'city=delhi&minPrice=',
    'city=delhi&minPrice=%20&maxPrice=',
    'city=delhi&minPrice=0',
    'city=delhi&minPrice=100&maxPrice=100',
    'city=delhi&minPrice=1.5&maxPrice=2',
    'city=delhi&maxPrice=5000',
    `city=${'a'.repeat(64)}`,
  ])('accepts valid query %s', async (qs) => {
    const res = await request(app).get(`/api/hotels?${qs}`);
    expect(res.status).toBe(200);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/hotels: validation', () => {
  it.each([
    ['missing city', ''],
    ['empty city', 'city='],
    ['whitespace city', 'city=%20%20'],
    ['repeated city', 'city=a&city=b'],
    ['city longer than 64 chars', `city=${'a'.repeat(65)}`],
    ['non-numeric minPrice', 'city=delhi&minPrice=abc'],
    ['negative minPrice', 'city=delhi&minPrice=-1'],
    ['exponent maxPrice', 'city=delhi&maxPrice=1e3'],
    ['Infinity maxPrice', 'city=delhi&maxPrice=Infinity'],
    ['repeated minPrice', 'city=delhi&minPrice=1&minPrice=2'],
    ['minPrice > maxPrice', 'city=delhi&minPrice=500&maxPrice=100'],
  ])('%s → 400 INVALID_QUERY', async (_label, qs) => {
    const res = await request(app).get(`/api/hotels?${qs}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'INVALID_QUERY', message: expect.any(String) },
    });
    expect(runner).not.toHaveBeenCalled();
    expect(cache.calls).toBe(0);
  });

  it('length limit applies after trim', async () => {
    const res = await request(app).get(`/api/hotels?city=%20${'a'.repeat(64)}%20`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/hotels: error mapping', () => {
  it.each([
    ['AllSuppliersFailedError', new AllSuppliersFailedError(), 503, 'ALL_SUPPLIERS_FAILED'],
    ['WorkflowTimeoutError', new WorkflowTimeoutError(), 503, 'WORKFLOW_TIMEOUT'],
    ['TemporalUnavailableError', new TemporalUnavailableError(), 503, 'TEMPORAL_UNAVAILABLE'],
  ])('%s → %i %s', async (_label, error, status, code) => {
    runner.mockRejectedValue(error);

    const res = await request(app).get('/api/hotels?city=delhi');

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: { code, message: expect.any(String) } });
  });

  it('unknown error → 500 INTERNAL_ERROR without leaking the message', async () => {
    runner.mockRejectedValue(new Error('boom'));

    const res = await request(app).get('/api/hotels?city=delhi');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });
});

describe('GET /api/hotels: cache', () => {
  it('MISS runs the workflow; the repeat is a HIT without a new workflow', async () => {
    const first = await request(app).get('/api/hotels?city=delhi');
    const second = await request(app).get('/api/hotels?city=delhi');

    expect(first.status).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');
    expect(first.body).toEqual(OFFERS);
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toEqual(first.body);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('filtered MISS serves the read-back from the cache', async () => {
    const res = await request(app).get('/api/hotels?city=delhi&minPrice=5000');

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.body).toEqual(OFFERS.slice(1));
    expect(cache.calls).toBe(2); // lookup + read-back
  });

  it('filtered HIT is served from the cache without the workflow', async () => {
    cache.data.set('delhi', { offers: OFFERS, failedSuppliers: [] });

    const res = await request(app).get('/api/hotels?city=delhi&minPrice=5000&maxPrice=6000');

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.body).toEqual([OFFERS[1]]);
    expect(runner).not.toHaveBeenCalled();
  });

  it('filtered HIT with no match → 200 [] (not a miss)', async () => {
    cache.data.set('delhi', { offers: OFFERS, failedSuppliers: [] });

    const res = await request(app).get('/api/hotels?city=delhi&minPrice=1&maxPrice=2');

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.body).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it('partial HIT keeps X-Failed-Suppliers from the cached meta', async () => {
    cache.data.set('delhi', { offers: OFFERS, failedSuppliers: ['Supplier B'] });

    const res = await request(app).get('/api/hotels?city=delhi');

    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.headers['x-failed-suppliers']).toBe('Supplier B');
  });

  it('Redis down, no filter → BYPASS with the live workflow result', async () => {
    cache.down = true;

    const res = await request(app).get('/api/hotels?city=delhi');

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('BYPASS');
    expect(res.body).toEqual(OFFERS);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('Redis down with a price filter → 503 CACHE_UNAVAILABLE without running the workflow', async () => {
    cache.down = true;

    const res = await request(app).get('/api/hotels?city=delhi&minPrice=5000');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: 'CACHE_UNAVAILABLE', message: expect.any(String) } });
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    ['save failed (cached: false)', { cached: false }, {}],
    ['read-back miss', {}, { save: false }],
  ])('%s → BYPASS without filter, 503 with filter', async (_label, extra, opts) => {
    resolveWith({ offers: OFFERS, failedSuppliers: [], ...extra }, opts);

    const plain = await request(app).get('/api/hotels?city=delhi');
    expect(plain.status).toBe(200);
    expect(plain.headers['x-cache']).toBe('BYPASS');
    expect(plain.body).toEqual(OFFERS);

    const filtered = await request(app).get('/api/hotels?city=delhi&maxPrice=6000');
    expect(filtered.status).toBe(503);
    expect(filtered.body.error.code).toBe('CACHE_UNAVAILABLE');
  });

  it('empty result → 200 [] MISS, even with a filter; nothing cached', async () => {
    resolveWith({ offers: [], failedSuppliers: [] });

    const res = await request(app).get('/api/hotels?city=goa&minPrice=100');

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.body).toEqual([]);
    expect(cache.data.has('goa')).toBe(false);
  });
});
