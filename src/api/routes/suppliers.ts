import { setTimeout as sleep } from 'node:timers/promises';
import { Router, type RequestHandler } from 'express';
import { config } from '../../config';
import { supplierAHotels, supplierBHotels } from '../../data/mockHotels';
import type { SupplierHotel, SupplierName } from '../../domain/types';
import { logger } from '../../logger';
import { AppError } from '../errors';

export interface SupplierRouterOptions {
  /** Force GET /supplierA/hotels to return 500. Default: config.supplierADown. */
  supplierADown: boolean;
  /** Force GET /supplierB/hotels to return 500. Default: config.supplierBDown. */
  supplierBDown: boolean;
  /** Simulated latency, awaited before every response. Default: 200–400 ms. */
  delay: () => Promise<void>;
}

const MIN_DELAY_MS = 200;
const MAX_DELAY_MS = 400;

/** Returns a function that waits a uniformly random whole number of ms in [minMs, maxMs]. */
export function randomDelay(minMs: number, maxMs: number): () => Promise<void> {
  return async () => {
    const ms = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
    await sleep(ms);
  };
}

/** Same rule as the env boolean flags: "true" or "1" → true. */
function isTruthyFlag(value: unknown): boolean {
  return value === 'true' || value === '1';
}

/**
 * Parses ?city.
 * - absent → undefined (no filter, return all hotels)
 * - string → trimmed + lowercased; empty after trim → 400
 * - anything else (e.g. repeated ?city=a&city=b → array) → 400
 */
function parseCity(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new AppError(400, 'INVALID_CITY', "Query parameter 'city' must be a single value");
  }
  const city = raw.trim().toLowerCase();
  if (city === '') {
    throw new AppError(400, 'INVALID_CITY', "Query parameter 'city' must not be empty");
  }
  return city;
}

function supplierHandler(
  supplier: SupplierName,
  hotels: readonly SupplierHotel[],
  isDown: boolean,
  delay: () => Promise<void>,
): RequestHandler {
  return async (req, res) => {
    const city = parseCity(req.query.city);

    await delay();

    const failByQuery = isTruthyFlag(req.query.fail);
    if (isDown || failByQuery) {
      const log = res.locals.log ?? logger;
      log.debug({ supplier, reason: isDown ? 'env' : 'query' }, 'simulated supplier failure');
      throw new AppError(500, 'SUPPLIER_UNAVAILABLE', `${supplier} is unavailable (simulated)`);
    }

    const result =
      city === undefined ? hotels : hotels.filter((h) => h.city.toLowerCase() === city);
    res.json(result);
  };
}

/** Mock supplier endpoints: GET /supplierA/hotels and GET /supplierB/hotels. */
export function createSupplierRouter(options: Partial<SupplierRouterOptions> = {}): Router {
  const {
    supplierADown = config.supplierADown,
    supplierBDown = config.supplierBDown,
    delay = randomDelay(MIN_DELAY_MS, MAX_DELAY_MS),
  } = options;

  const router = Router();
  router.get('/supplierA/hotels', supplierHandler('Supplier A', supplierAHotels, supplierADown, delay));
  router.get('/supplierB/hotels', supplierHandler('Supplier B', supplierBHotels, supplierBDown, delay));
  return router;
}
