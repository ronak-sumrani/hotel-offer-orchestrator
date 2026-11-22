/**
 * Temporal workflows. This file is bundled into the deterministic workflow
 * sandbox: NO I/O, no Node APIs, no config/logger/zod imports, no Date.now or
 * Math.random. Only @temporalio/workflow and pure code from src/domain.
 */
import { ApplicationFailure, log, proxyActivities } from '@temporalio/workflow';
import { selectBestOffers } from '../domain/selectBestOffers';
import type { SupplierHotel, SupplierName } from '../domain/types';
import type { HotelActivities } from './activities';
import { ALL_SUPPLIERS_FAILED, type HotelOffersInput, type HotelOffersResult } from './shared';

export { ALL_SUPPLIERS_FAILED };
export type { HotelOffersInput, HotelOffersResult };

const { fetchSupplierA, fetchSupplierB } = proxyActivities<HotelActivities>({
  startToCloseTimeout: '5s',
  retry: {
    maximumAttempts: 3,
    initialInterval: '500ms',
    backoffCoefficient: 2,
  },
});

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    // ActivityFailure wraps the real error in `cause`.
    const cause = (reason as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : reason.message;
  }
  return String(reason);
}

export async function hotelOffersWorkflow(input: HotelOffersInput): Promise<HotelOffersResult> {
  const { city } = input;

  // Both activities are scheduled in the same workflow task → they run concurrently.
  const [a, b] = await Promise.allSettled([fetchSupplierA(city), fetchSupplierB(city)]);

  const failedSuppliers: SupplierName[] = [];
  const errors: Partial<Record<SupplierName, string>> = {};

  const unwrap = (supplier: SupplierName, r: PromiseSettledResult<SupplierHotel[]>): SupplierHotel[] => {
    if (r.status === 'fulfilled') return r.value;
    const message = errorMessage(r.reason);
    failedSuppliers.push(supplier);
    errors[supplier] = message;
    log.warn('supplier failed after retries', { supplier, city, error: message });
    return [];
  };

  const offersA = unwrap('Supplier A', a);
  const offersB = unwrap('Supplier B', b);

  if (failedSuppliers.length === 2) {
    throw ApplicationFailure.create({
      type: ALL_SUPPLIERS_FAILED,
      message: `All suppliers failed for city "${city}"`,
      nonRetryable: true,
      details: [errors],
    });
  }

  const offers = selectBestOffers(offersA, offersB);
  log.info('hotel offers selected', { city, count: offers.length, failedSuppliers });
  return { offers, failedSuppliers };
}
