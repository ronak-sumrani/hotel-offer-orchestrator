/**
 * Temporal activities: all supplier I/O lives here (never in workflow code).
 *
 * Runs in plain Node inside the worker, so it may use fetch, zod, timers, etc.
 * Workflows import this module with `import type` only, so it is never bundled
 * into the workflow sandbox.
 */
import { ApplicationFailure, Context } from '@temporalio/activity';
import { z } from 'zod';
import type { BestOffer, SupplierHotel, SupplierName } from '../domain/types';
import type { HotelStore } from '../redis/hotelRepository';

export const INVALID_SUPPLIER_RESPONSE = 'InvalidSupplierResponse';

const DEFAULT_FETCH_TIMEOUT_MS = 4000;

const supplierHotelSchema = z.object({
  hotelId: z.string(),
  name: z.string().min(1),
  price: z.number().finite().nonnegative(),
  city: z.string(),
  commissionPct: z.number().finite().nonnegative(),
}) satisfies z.ZodType<SupplierHotel>;

const supplierPayloadSchema = z.array(supplierHotelSchema);

export interface ActivityDeps {
  /** Base URL of the mock supplier endpoints, without trailing slash. */
  supplierBaseUrl: string;
  /** Per-attempt HTTP timeout. Kept below the 5s startToCloseTimeout. Default 4000. */
  fetchTimeoutMs?: number;
  /** Injectable for tests. Default: globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Where saveToRedis writes. */
  hotelStore: HotelStore;
}

export function createActivities(deps: ActivityDeps) {
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const doFetch = deps.fetch ?? globalThis.fetch;

  async function fetchSupplier(
    supplier: SupplierName,
    path: string,
    city: string,
  ): Promise<SupplierHotel[]> {
    const ctx = Context.current();
    const { attempt } = ctx.info;
    const url = `${deps.supplierBaseUrl}${path}?city=${encodeURIComponent(city)}`;
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);

    let body: unknown;
    let status: number | undefined;
    try {
      const res = await doFetch(url, {
        signal: AbortSignal.any([ctx.cancellationSignal, AbortSignal.timeout(fetchTimeoutMs)]),
      });
      status = res.status;
      if (!res.ok) {
        // Plain Error → retryable per the activity retry policy.
        throw new Error(`${supplier} responded with HTTP ${res.status}`);
      }
      try {
        body = await res.json();
      } catch (err) {
        throw ApplicationFailure.nonRetryable(
          `${supplier} returned a non-JSON body: ${(err as Error).message}`,
          INVALID_SUPPLIER_RESPONSE,
        );
      }
    } catch (err) {
      ctx.log.warn('supplier fetch failed', {
        supplier,
        city,
        attempt,
        durationMs: elapsed(),
        status,
        error: (err as Error).message,
      });
      throw err;
    }

    const parsed = supplierPayloadSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      ctx.log.warn('supplier payload invalid', {
        supplier,
        city,
        attempt,
        durationMs: elapsed(),
        issues,
      });
      throw ApplicationFailure.nonRetryable(
        `${supplier} returned a malformed payload`,
        INVALID_SUPPLIER_RESPONSE,
        { issues },
      );
    }

    ctx.log.info('supplier fetch succeeded', {
      supplier,
      city,
      attempt,
      durationMs: elapsed(),
      status,
      count: parsed.data.length,
    });
    return parsed.data;
  }

  return {
    async fetchSupplierA(city: string): Promise<SupplierHotel[]> {
      return fetchSupplier('Supplier A', '/supplierA/hotels', city);
    },
    async fetchSupplierB(city: string): Promise<SupplierHotel[]> {
      return fetchSupplier('Supplier B', '/supplierB/hotels', city);
    },
    /** Retryable on any Redis failure (plain error); the workflow tolerates final failure. */
    async saveToRedis(city: string, offers: BestOffer[], failedSuppliers: SupplierName[]): Promise<void> {
      const ctx = Context.current();
      const started = performance.now();
      const meta = {
        city,
        attempt: ctx.info.attempt,
        count: offers.length,
        partial: failedSuppliers.length > 0,
      };
      try {
        await deps.hotelStore.saveOffers(city, offers, failedSuppliers);
      } catch (err) {
        ctx.log.warn('saveToRedis failed', {
          ...meta,
          durationMs: Math.round(performance.now() - started),
          error: (err as Error).message,
        });
        throw err;
      }
      ctx.log.info('saveToRedis succeeded', { ...meta, durationMs: Math.round(performance.now() - started) });
    },
  };
}

export type HotelActivities = ReturnType<typeof createActivities>;
