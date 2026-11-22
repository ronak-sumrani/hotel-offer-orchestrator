import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { BestOffer } from '../../domain/types';
import { logger } from '../../logger';
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
}

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

/** GET /api/hotels?city=&minPrice=&maxPrice= */
export function createHotelsRouter(options: Partial<HotelsRouterOptions> = {}): Router {
  const runHotelOffers = options.runHotelOffers ?? createTemporalRunner();

  const router = Router();
  router.get('/api/hotels', async (req, res) => {
    // minPrice/maxPrice are validated now; filtering arrives with Redis (Phase 7).
    const { city } = parseQuery(req.query);
    const workflowId = `hotel-offers-${city}-${randomUUID()}`;
    const log = (res.locals.log ?? logger).child({ city, workflowId });
    const started = performance.now();

    let result;
    try {
      result = await runHotelOffers({ city }, { workflowId });
    } catch (err) {
      const mapped = toHttpError(err);
      if (mapped instanceof AppError) {
        log.warn({ err, code: mapped.code, durationMs: Math.round(performance.now() - started) }, 'hotel search failed');
      }
      throw mapped;
    }

    const { offers, failedSuppliers } = result;
    if (failedSuppliers.length > 0) {
      res.setHeader('X-Failed-Suppliers', failedSuppliers.join(','));
    }
    log.info(
      { count: offers.length, failedSuppliers, durationMs: Math.round(performance.now() - started) },
      'hotel search completed',
    );
    res.json(offers.map(toResponseItem));
  });
  return router;
}
