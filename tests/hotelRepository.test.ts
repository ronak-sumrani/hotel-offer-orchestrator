/**
 * Integration tests against a real Redis (docker compose). Uses DB 15 and a
 * unique key prefix per run; every key is removed afterwards. Skipped, with
 * a printed warning, when Redis is unreachable.
 *   REDIS_TEST_URL (default redis://localhost:6379/15)
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { selectBestOffers } from '../src/domain/selectBestOffers';
import type { BestOffer, SupplierHotel } from '../src/domain/types';
import { closeRedisClient, createRedisClient } from '../src/redis/client';
import { createHotelRepository, type HotelRepository } from '../src/redis/hotelRepository';

const REDIS_TEST_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/15';
const TTL = 300;
const PARTIAL_TTL = 30;
const silent = pino({ level: 'silent' });

const DELHI: BestOffer[] = [
  { name: 'Lemon Tree', price: 3200, supplier: 'Supplier A', commissionPct: 8 },
  { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
  { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
  { name: 'ITC Maurya', price: 8800, supplier: 'Supplier B', commissionPct: 15 },
  { name: 'Taj Palace', price: 9500, supplier: 'Supplier A', commissionPct: 12 },
];

let client: Redis;
let available = false;
const prefix = `test-${randomUUID()}:hotels`;
let repo: HotelRepository;

function waitReady(c: Redis, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    c.once('ready', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

beforeAll(async () => {
  client = createRedisClient({ name: 'test', url: REDIS_TEST_URL, commandTimeoutMs: 1_000, log: silent });
  available = await waitReady(client, 2_000);
  if (!available) {
    // process.stderr, not console.warn: vitest hides console output of fully skipped files.
    process.stderr.write(
      `\n[hotelRepository.test] Redis not reachable at ${REDIS_TEST_URL}: SKIPPING (run docker compose up -d)\n\n`,
    );
    await closeRedisClient(client);
    return;
  }
  console.info(`[hotelRepository.test] running against ${REDIS_TEST_URL} with prefix ${prefix}`);
  repo = createHotelRepository({
    getClient: () => client,
    ttlSeconds: TTL,
    partialTtlSeconds: PARTIAL_TTL,
    keyPrefix: prefix,
    log: silent,
  });
});

beforeEach((ctx) => {
  if (!available) ctx.skip();
});

afterEach(async () => {
  if (!available) return;
  const keys = await client.keys(`${prefix}:*`);
  if (keys.length > 0) await client.del(...keys);
});

afterAll(async () => {
  if (available) await closeRedisClient(client);
});

const names = (offers: BestOffer[] | undefined): string[] => (offers ?? []).map((o) => o.name);

describe('hotelRepository (real Redis)', () => {
  it('save then read with no bounds returns everything in price order', async () => {
    await repo.saveOffers('delhi', DELHI, []);

    expect(await repo.findByPriceRange('delhi')).toEqual({ offers: DELHI, failedSuppliers: [] });
  });

  it('writes the documented key layout', async () => {
    await repo.saveOffers('delhi', DELHI, []);

    const zset = await client.zrange(`${prefix}:delhi`, '0', '-1', 'WITHSCORES');
    expect(zset).toEqual(DELHI.flatMap((o) => [o.name, String(o.price)]));
    const details = await client.hgetall(`${prefix}:delhi:details`);
    expect(JSON.parse(details['Holtin']!)).toEqual(DELHI[1]);
    expect(await client.get(`${prefix}:delhi:meta`)).toBe('{"failedSuppliers":[]}');
  });

  it('full success → TTL ≈ 300 on all three keys', async () => {
    await repo.saveOffers('delhi', DELHI, []);

    for (const key of [`${prefix}:delhi`, `${prefix}:delhi:details`, `${prefix}:delhi:meta`]) {
      const ttl = await client.ttl(key);
      expect(ttl, key).toBeGreaterThan(TTL - 5);
      expect(ttl, key).toBeLessThanOrEqual(TTL);
    }
  });

  it('partial result → TTL ≈ 30 on all three keys and failedSuppliers returned', async () => {
    await repo.saveOffers('delhi', DELHI.slice(0, 2), ['Supplier B']);

    for (const key of [`${prefix}:delhi`, `${prefix}:delhi:details`, `${prefix}:delhi:meta`]) {
      const ttl = await client.ttl(key);
      expect(ttl, key).toBeGreaterThan(PARTIAL_TTL - 5);
      expect(ttl, key).toBeLessThanOrEqual(PARTIAL_TTL);
    }
    expect((await repo.findByPriceRange('delhi'))?.failedSuppliers).toEqual(['Supplier B']);
  });

  it('empty offers → nothing written, read is a miss', async () => {
    await repo.saveOffers('goa', [], []);

    expect(await client.keys(`${prefix}:goa*`)).toEqual([]);
    expect(await repo.findByPriceRange('goa')).toBeNull();
  });

  it('unknown city → null (miss)', async () => {
    expect(await repo.findByPriceRange('nowhere')).toBeNull();
  });

  it.each([
    ['min only', 9000, undefined, ['Taj Palace']],
    ['max only', undefined, 3500, ['Lemon Tree']],
    ['both', 5000, 6000, ['Holtin', 'Radison']],
    ['both bounds inclusive', 5340, 8800, ['Holtin', 'Radison', 'ITC Maurya']],
    ['single-point inclusive', 5900, 5900, ['Radison']],
  ])('price range: %s', async (_label, min, max, expected) => {
    await repo.saveOffers('delhi', DELHI, []);

    expect(names((await repo.findByPriceRange('delhi', min, max))?.offers)).toEqual(expected);
  });

  it('price range with no match is a hit with [] (not a miss)', async () => {
    await repo.saveOffers('delhi', DELHI, ['Supplier A']);

    expect(await repo.findByPriceRange('delhi', 1, 2)).toEqual({ offers: [], failedSuppliers: ['Supplier A'] });
  });

  it('equal prices come back in the same order as selectBestOffers', async () => {
    const input: SupplierHotel[] = ['Zeta', 'beta', 'Alpha', 'Mid'].map((name, i) => ({
      hotelId: `h${i}`,
      name,
      price: name === 'Mid' ? 50 : 100,
      city: 'delhi',
      commissionPct: 10,
    }));
    const expected = selectBestOffers(input, []);
    expect(names(expected)).toEqual(['Mid', 'Alpha', 'Zeta', 'beta']); // code-unit order

    await repo.saveOffers('delhi', expected, []);

    expect((await repo.findByPriceRange('delhi'))?.offers).toEqual(expected);
  });

  it('a second save replaces the first completely', async () => {
    await repo.saveOffers('delhi', DELHI, []);
    await repo.saveOffers('delhi', [DELHI[4]!], []);

    expect(names((await repo.findByPriceRange('delhi'))?.offers)).toEqual(['Taj Palace']);
    expect(await client.hlen(`${prefix}:delhi:details`)).toBe(1);
  });

  it('city is URI-encoded in keys, so "a:details" cannot collide with "a"', async () => {
    await repo.saveOffers('a', [DELHI[0]!], []);
    await repo.saveOffers('a:details', [DELHI[1]!], []);

    expect(names((await repo.findByPriceRange('a'))?.offers)).toEqual(['Lemon Tree']);
    expect(names((await repo.findByPriceRange('a:details'))?.offers)).toEqual(['Holtin']);
    expect(await client.exists(`${prefix}:a%3Adetails`)).toBe(1);
  });

  it('a missing details field is treated as a miss', async () => {
    await repo.saveOffers('delhi', DELHI, []);
    await client.hdel(`${prefix}:delhi:details`, 'Holtin');

    expect(await repo.findByPriceRange('delhi')).toBeNull();
  });
});
