import { describe, expect, it } from 'vitest';
import { supplierAHotels, supplierBHotels } from '../src/data/mockHotels';
import { selectBestOffers } from '../src/domain/selectBestOffers';
import type { SupplierHotel } from '../src/domain/types';

const inCity = (list: readonly SupplierHotel[], city: string) =>
  list.filter((x) => x.city === city);

const bestFor = (city: string) =>
  selectBestOffers(inCity(supplierAHotels, city), inCity(supplierBHotels, city));

describe('mock hotels + selectBestOffers', () => {
  it('15. delhi result', () => {
    expect(bestFor('delhi')).toEqual([
      { name: 'Lemon Tree', price: 3200, supplier: 'Supplier A', commissionPct: 8 },
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
      { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
      { name: 'ITC Maurya', price: 8800, supplier: 'Supplier B', commissionPct: 15 },
      { name: 'Taj Palace', price: 9500, supplier: 'Supplier A', commissionPct: 12 },
    ]);
  });

  it('16. mumbai result', () => {
    expect(bestFor('mumbai')).toEqual([
      { name: 'Sea Princess', price: 4500, supplier: 'Supplier B', commissionPct: 11 },
      { name: 'Marine Plaza', price: 6500, supplier: 'Supplier A', commissionPct: 9 },
      { name: 'Trident', price: 7000, supplier: 'Supplier A', commissionPct: 12 },
      { name: 'The Oberoi', price: 11500, supplier: 'Supplier B', commissionPct: 14 },
    ]);
  });

  it('17. data sanity', () => {
    for (const list of [supplierAHotels, supplierBHotels]) {
      const ids = list.map((x) => x.hotelId);
      expect(ids.every((id) => id.trim().length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);

      for (const item of list) {
        expect(item.city).toBe(item.city.toLowerCase());
        expect(item.price).toBeGreaterThan(0);
        expect(item.commissionPct).toBeGreaterThanOrEqual(0);
        expect(item.commissionPct).toBeLessThanOrEqual(100);
      }

      const cities = new Set(list.map((x) => x.city));
      expect(cities.has('delhi')).toBe(true);
      expect(cities.has('mumbai')).toBe(true);
      expect(cities.has('goa')).toBe(false);
    }
  });
});
