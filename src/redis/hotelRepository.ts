/**
 * Redis storage for deduped hotel offers, per city:
 *
 *   {prefix}:{city}          ZSET    member = hotel name, score = price
 *   {prefix}:{city}:details  HASH    field = hotel name, value = JSON BestOffer
 *   {prefix}:{city}:meta     STRING  JSON { failedSuppliers }
 *
 * All three keys are written in one MULTI with the same TTL. Price filtering
 * happens in Redis (ZRANGEBYSCORE), never in application code.
 */
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { SUPPLIER_NAMES, type BestOffer, type SupplierName } from '../domain/types';
import { logger, type Logger } from '../logger';

export const DEFAULT_KEY_PREFIX = 'hotels';

/** Any Redis failure (connection, timeout, command error). Wraps the ioredis error. */
export class CacheUnavailableError extends Error {
  constructor(message = 'Redis is unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'CacheUnavailableError';
  }
}

export interface CachedOffers {
  offers: BestOffer[];
  failedSuppliers: SupplierName[];
}

/** Read side, used by the API. */
export interface HotelCache {
  /**
   * Offers with min <= price <= max (missing bound = unbounded), in Redis order
   * (price, then name bytes). Returns null on cache miss. A hit with no
   * matching offers returns { offers: [] }. Throws CacheUnavailableError.
   */
  findByPriceRange(city: string, minPrice?: number, maxPrice?: number): Promise<CachedOffers | null>;
}

/** Write side, used by the worker's saveToRedis activity. */
export interface HotelStore {
  /**
   * Replaces the city's cached offers atomically. Empty offers → no-op (not
   * cached). TTL = ttlSeconds, or partialTtlSeconds if any supplier failed.
   * Throws CacheUnavailableError.
   */
  saveOffers(city: string, offers: readonly BestOffer[], failedSuppliers: readonly SupplierName[]): Promise<void>;
}

export type HotelRepository = HotelCache & HotelStore;

export interface HotelRepositoryDeps {
  /** Called on every operation, so the client is only created when first used. */
  getClient: () => Redis;
  ttlSeconds: number;
  partialTtlSeconds: number;
  /** Default "hotels". Tests use a unique prefix. */
  keyPrefix?: string;
  log?: Logger;
}

const bestOfferSchema = z.object({
  name: z.string(),
  price: z.number(),
  supplier: z.enum(SUPPLIER_NAMES),
  commissionPct: z.number(),
}) satisfies z.ZodType<BestOffer>;

const metaSchema = z.object({ failedSuppliers: z.array(z.enum(SUPPLIER_NAMES)) });

type ExecResult = [error: Error | null, result: unknown][] | null;

/** Throws on an aborted transaction or on any per-command error inside EXEC. */
function unwrapExec(results: ExecResult): unknown[] {
  if (results === null) throw new Error('MULTI transaction aborted');
  return results.map(([err, value]) => {
    if (err) throw err;
    return value;
  });
}

function parseJson<T>(schema: z.ZodType<T>, raw: string): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function createHotelRepository(deps: HotelRepositoryDeps): HotelRepository {
  const prefix = deps.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const log = (deps.log ?? logger).child({ component: 'hotelRepository' });

  /** City is URI-encoded so e.g. "a:details" cannot collide with city "a"'s keys. */
  function keysFor(city: string) {
    const base = `${prefix}:${encodeURIComponent(city)}`;
    return { zset: base, details: `${base}:details`, meta: `${base}:meta` };
  }

  async function guarded<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CacheUnavailableError) throw err;
      throw new CacheUnavailableError(`Redis ${op} failed: ${(err as Error).message}`, { cause: err });
    }
  }

  return {
    async saveOffers(city, offers, failedSuppliers) {
      if (offers.length === 0) return;
      const keys = keysFor(city);
      const ttl = failedSuppliers.length > 0 ? deps.partialTtlSeconds : deps.ttlSeconds;

      const zaddArgs = offers.flatMap((o) => [o.price, o.name]);
      const details = new Map(
        offers.map((o) => [
          o.name,
          JSON.stringify({ name: o.name, price: o.price, supplier: o.supplier, commissionPct: o.commissionPct }),
        ]),
      );
      const meta = JSON.stringify({ failedSuppliers });

      await guarded('save', async () => {
        const results = await deps
          .getClient()
          .multi()
          .del(keys.zset, keys.details, keys.meta)
          .zadd(keys.zset, ...zaddArgs)
          .hset(keys.details, details)
          .set(keys.meta, meta, 'EX', ttl)
          .expire(keys.zset, ttl)
          .expire(keys.details, ttl)
          .exec();
        unwrapExec(results);
      });
    },

    async findByPriceRange(city, minPrice, maxPrice) {
      const keys = keysFor(city);
      const min = minPrice ?? '-inf';
      const max = maxPrice ?? '+inf';

      return guarded('read', async () => {
        const client = deps.getClient();
        const [exists, rawMeta, members] = unwrapExec(
          await client.multi().exists(keys.zset).get(keys.meta).zrangebyscore(keys.zset, min, max).exec(),
        ) as [number, string | null, string[]];

        if (exists !== 1 || rawMeta === null) return null;

        const meta = parseJson(metaSchema, rawMeta);
        if (!meta) {
          log.warn({ city, key: keys.meta }, 'corrupt cache meta, treating as miss');
          return null;
        }
        if (members.length === 0) return { offers: [], failedSuppliers: meta.failedSuppliers };

        const rawDetails = await client.hmget(keys.details, ...members);
        const offers: BestOffer[] = [];
        for (const [i, raw] of rawDetails.entries()) {
          const offer = raw === null ? undefined : parseJson(bestOfferSchema, raw);
          if (!offer) {
            // Expired or rewritten between the two round trips, or corrupt.
            log.warn({ city, member: members[i] }, 'cache details missing or corrupt, treating as miss');
            return null;
          }
          offers.push(offer);
        }
        return { offers, failedSuppliers: meta.failedSuppliers };
      });
    },
  };
}
