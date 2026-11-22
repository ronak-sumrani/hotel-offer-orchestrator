/**
 * Constants and types shared by the workflow (sandbox) and the API (plain Node).
 * WORKFLOW-SAFE: no imports except types from src/domain, no I/O, no Node APIs.
 * The API imports from here instead of workflows.ts so it never loads
 * @temporalio/workflow at runtime.
 */
import type { BestOffer, SupplierName } from '../domain/types';

/** ApplicationFailure type thrown by the workflow when every supplier failed. */
export const ALL_SUPPLIERS_FAILED = 'AllSuppliersFailed';

/** Registered workflow name (string, so callers need only a type-only import). */
export const HOTEL_OFFERS_WORKFLOW = 'hotelOffersWorkflow';

export interface HotelOffersInput {
  city: string;
}

export interface HotelOffersResult {
  offers: BestOffer[];
  failedSuppliers: SupplierName[];
}
