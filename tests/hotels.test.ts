import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/api/server';
import type { BestOffer } from '../src/domain/types';
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

const runner = vi.fn<RunHotelOffers>();
const app = createApp({
  suppliers: { delay: async () => {} },
  hotels: { runHotelOffers: runner },
});

function resolveWith(result: HotelOffersResult): void {
  runner.mockResolvedValue(result);
}

beforeEach(() => {
  runner.mockReset();
  resolveWith({ offers: OFFERS, failedSuppliers: [] });
});

describe('GET /api/hotels: success', () => {
  it('returns the bare array in workflow order with exactly the response fields', async () => {
    // Extra field from the runner must not leak into the response.
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
