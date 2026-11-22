import type { SupplierHotel } from '../domain/types';

/**
 * Hardcoded supplier data. Flat lists; filtering by city happens in the
 * mock endpoints. Messy spellings sit on the losing side so API output
 * stays clean.
 *
 * Scenarios covered:
 * - delhi Holtin: B cheaper → B wins
 * - delhi Radison: A cheaper; B spelled "  RADISON " → A wins as "Radison"
 * - mumbai Trident: exact price tie → A wins
 * - mumbai The Oberoi: A spelled "the oberoi " loses to B "The Oberoi"
 * - unique hotels on each side in both cities
 */
export const supplierAHotels: readonly SupplierHotel[] = [
  { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
  { hotelId: 'a2', name: 'Radison', price: 5900, city: 'delhi', commissionPct: 13 },
  { hotelId: 'a3', name: 'Taj Palace', price: 9500, city: 'delhi', commissionPct: 12 },
  { hotelId: 'a4', name: 'Lemon Tree', price: 3200, city: 'delhi', commissionPct: 8 },
  { hotelId: 'a5', name: 'Trident', price: 7000, city: 'mumbai', commissionPct: 12 },
  { hotelId: 'a6', name: 'the oberoi ', price: 12000, city: 'mumbai', commissionPct: 10 },
  { hotelId: 'a7', name: 'Marine Plaza', price: 6500, city: 'mumbai', commissionPct: 9 },
];

export const supplierBHotels: readonly SupplierHotel[] = [
  { hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20 },
  { hotelId: 'b2', name: '  RADISON ', price: 6100, city: 'delhi', commissionPct: 11 },
  { hotelId: 'b3', name: 'ITC Maurya', price: 8800, city: 'delhi', commissionPct: 15 },
  { hotelId: 'b4', name: 'Trident', price: 7000, city: 'mumbai', commissionPct: 15 },
  { hotelId: 'b5', name: 'The Oberoi', price: 11500, city: 'mumbai', commissionPct: 14 },
  { hotelId: 'b6', name: 'Sea Princess', price: 4500, city: 'mumbai', commissionPct: 11 },
];
