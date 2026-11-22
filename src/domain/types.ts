/**
 * WORKFLOW-SAFE MODULE: src/domain is imported by Temporal workflow code and
 * bundled into the deterministic workflow sandbox. Keep it pure: no I/O, no
 * Node APIs (node:*), no config/logger/zod/ioredis imports, no Date.now or
 * Math.random. Type-only imports are fine.
 */
export const SUPPLIER_NAMES = ['Supplier A', 'Supplier B'] as const;
export type SupplierName = (typeof SUPPLIER_NAMES)[number];

/** One hotel item exactly as a supplier returns it. */
export interface SupplierHotel {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
}

/** One item of the API response. */
export interface BestOffer {
  name: string;
  price: number;
  supplier: SupplierName;
  commissionPct: number;
}
