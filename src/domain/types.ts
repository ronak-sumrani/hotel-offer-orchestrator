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
