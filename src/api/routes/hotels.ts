import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { BestOffer } from '../../domain/types';
import { config } from '../../config';
import { logger } from '../../logger';
import { getApiRedis } from '../../redis/client';
import {
  CacheUnavailableError,
  createHotelRepository,
  type CachedOffers,
  type HotelCache,
} from '../../redis/hotelRepository';
import {
  AllSuppliersFailedError,
  createTemporalRunner,
  TemporalUnavailableError,
  WorkflowTimeoutError,
  type RunHotelOffers,
} from '../../temporal/runner';
import { AppError } from '../errors';

export interface HotelsRouterOptions {
  /** Runs the hotel-offers workflow. Default: real Temporal client. Tests inject a fake. */
  runHotelOffers: RunHotelOffers;
  /** Redis-backed offer cache. Default: real Redis (lazy). Tests inject a fake. */
  hotelCache: HotelCache;
}

type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

const CITY_MAX_LENGTH = 64;

/** Plain decimal only: rejects "abc", "1e3", "0x10", "Infinity", "+5", ".5". */
const DECIMAL = /^-?\d+(\.\d+)?$/;

const priceParam = z
  .preprocess(
    // Empty / whitespace-only → missing (NOT 0).
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z
      .string({ error: 'must be a single numeric value' })
      .trim()
      .regex(DECIMAL, 'must be a number')
      .transform(Number)
      .pipe(z.number().nonnegative('must be >= 0'))
      .optional(),
  )
  .optional();

export const hotelsQuerySchema = z
  .object({
    city: z
      .string({ error: (issue) => (issue.input === undefined ? 'is required' : 'must be a single value') })
      .trim()
      .toLowerCase()
      .min(1, 'must not be empty')
      .max(CITY_MAX_LENGTH, `must be at most ${CITY_MAX_LENGTH} characters`),
    minPrice: priceParam,
    maxPrice: priceParam,
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    path: ['minPrice'],
    message: 'must be <= maxPrice',
  });

export type HotelsQuery = z.infer<typeof hotelsQuerySchema>;

function parseQuery(query: unknown): HotelsQuery {
  const result = hotelsQuerySchema.safeParse(query);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw new AppError(400, 'INVALID_QUERY', message);
  }
  return result.data;
}

/** Exactly the response fields, nothing else. */
function toResponseItem(o: BestOffer): BestOffer {
  return { name: o.name, price: o.price, supplier: o.supplier, commissionPct: o.commissionPct };
}

/** Maps runner errors to HTTP errors; unknown errors pass through (→ 500). */
function toHttpError(err: unknown): unknown {
  if (err instanceof AllSuppliersFailedError) {
    return new AppError(503, 'ALL_SUPPLIERS_FAILED', 'All suppliers failed; try again later');
  }
  if (err instanceof WorkflowTimeoutError) {
    return new AppError(503, 'WORKFLOW_TIMEOUT', 'Hotel search timed out; try again later');
  }
  if (err instanceof TemporalUnavailableError) {
    return new AppError(503, 'TEMPORAL_UNAVAILABLE', 'Workflow service is unavailable; try again later');
  }
  return err;
}

/** Default cache: Redis via the API's shared client, created on first request. */
function defaultHotelCache(): HotelCache {
  return createHotelRepository({
    getClient: getApiRedis,
    ttlSeconds: config.cacheTtlSeconds,
    partialTtlSeconds: config.partialCacheTtlSeconds,
  });
}

const cacheUnavailable = (): AppError =>
  new AppError(503, 'CACHE_UNAVAILABLE', 'Price filtering is temporarily unavailable; try again later');

/**
 * GET /api/hotels?city=&minPrice=&maxPrice=
 *
 * Cache-aside, single read path: a hit is served from Redis; a miss runs the
 * workflow (which saves to Redis) and then reads back from Redis, so price
 * filtering always happens in Redis. If Redis is unusable, an unfiltered
 * request falls back to the live workflow result (X-Cache: BYPASS) and a
 * filtered one gets 503 CACHE_UNAVAILABLE.
 */
export function createHotelsRouter(options: Partial<HotelsRouterOptions> = {}): Router {
  const runHotelOffers = options.runHotelOffers ?? createTemporalRunner();
  const cache = options.hotelCache ?? defaultHotelCache();

  const router = Router();
  router.get('/api/hotels', async (req, res) => {
    const { city, minPrice, maxPrice } = parseQuery(req.query);
    const hasFilter = minPrice !== undefined || maxPrice !== undefined;
    const workflowId = `hotel-offers-${city}-${randomUUID()}`;
    const log = (res.locals.log ?? logger).child({ city, minPrice, maxPrice });
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);

    const send = (cacheStatus: CacheStatus, offers: BestOffer[], failedSuppliers: readonly string[]): void => {
      res.setHeader('X-Cache', cacheStatus);
      if (failedSuppliers.length > 0) res.setHeader('X-Failed-Suppliers', failedSuppliers.join(','));
      log.info(
        {
          cache: cacheStatus,
          // A HIT runs no workflow, so there is no workflowId to correlate.
          workflowId: cacheStatus === 'HIT' ? undefined : workflowId,
          count: offers.length,
          failedSuppliers,
          durationMs: elapsed(),
        },
        'hotel search completed',
      );
      res.json(offers.map(toResponseItem));
    };

    /** Returns null on miss; undefined when Redis is unavailable. */
    const readCache = async (stage: 'lookup' | 'read-back'): Promise<CachedOffers | null | undefined> => {
      try {
        return await cache.findByPriceRange(city, minPrice, maxPrice);
      } catch (err) {
        if (!(err instanceof CacheUnavailableError)) throw err;
        log.warn({ err: err.message, stage }, 'cache unavailable');
        return undefined;
      }
    };

    // 1. Cache lookup.
    const hit = await readCache('lookup');
    if (hit) {
      send('HIT', hit.offers, hit.failedSuppliers);
      return;
    }
    // 2. Redis down and a filter was asked: the workflow cannot help.
    if (hit === undefined && hasFilter) {
      log.warn({ durationMs: elapsed() }, 'price filter requested while cache unavailable');
      throw cacheUnavailable();
    }

    // 3. Miss: run the workflow (it saves to Redis).
    let result;
    try {
      result = await runHotelOffers({ city }, { workflowId });
    } catch (err) {
      const mapped = toHttpError(err);
      if (mapped instanceof AppError) {
        log.warn({ err, workflowId, code: mapped.code, durationMs: elapsed() }, 'hotel search failed');
      } else {
        // Unexpected (e.g. workflow terminated/cancelled, namespace not found) → 500.
        log.error({ err, workflowId, durationMs: elapsed() }, 'hotel search failed unexpectedly');
      }
      throw mapped;
    }
    const { offers, failedSuppliers, cached } = result;

    // 4. Empty: nothing cached, nothing to filter.
    if (offers.length === 0) {
      send('MISS', [], failedSuppliers);
      return;
    }

    // 5. Read back from Redis so filtering happens there.
    const fresh = cached ? await readCache('read-back') : undefined;
    if (fresh) {
      send('MISS', fresh.offers, fresh.failedSuppliers);
      return;
    }

    // 6. Not cached, Redis down, or read-back miss.
    log.warn({ workflowId, cached, readBack: fresh === null ? 'miss' : 'unavailable' }, 'serving without cache');
    if (hasFilter) throw cacheUnavailable();
    send('BYPASS', offers, failedSuppliers);
  });
  return router;
}
