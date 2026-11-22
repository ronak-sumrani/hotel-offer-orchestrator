import { describe, expect, it } from 'vitest';
import { selectBestOffers } from '../src/domain/selectBestOffers';
import type { SupplierHotel } from '../src/domain/types';

let seq = 0;
function h(name: string, price: number, commissionPct = 10, city = 'delhi'): SupplierHotel {
  seq += 1;
  return { hotelId: `x${seq}`, name, price, city, commissionPct };
}

function deepFreeze<T>(list: T[]): readonly T[] {
  list.forEach((item) => Object.freeze(item));
  return Object.freeze(list);
}

describe('selectBestOffers', () => {
  it('1. B cheaper → B offer wins with B price and commission', () => {
    const result = selectBestOffers([h('Holtin', 6000, 10)], [h('Holtin', 5340, 20)]);
    expect(result).toEqual([
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
    ]);
  });

  it('2. A cheaper → A offer wins with A price and commission', () => {
    const result = selectBestOffers([h('Radison', 5900, 13)], [h('Radison', 6100, 11)]);
    expect(result).toEqual([
      { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
    ]);
  });

  it('3. exact cross-supplier price tie → Supplier A kept', () => {
    const result = selectBestOffers([h('Trident', 7000, 12)], [h('Trident', 7000, 15)]);
    expect(result).toEqual([
      { name: 'Trident', price: 7000, supplier: 'Supplier A', commissionPct: 12 },
    ]);
  });

  it('4. hotel only in A is included and labelled Supplier A', () => {
    const result = selectBestOffers([h('Taj Palace', 9500)], []);
    expect(result).toEqual([
      { name: 'Taj Palace', price: 9500, supplier: 'Supplier A', commissionPct: 10 },
    ]);
  });

  it('5. hotel only in B is included and labelled Supplier B', () => {
    const result = selectBestOffers([], [h('ITC Maurya', 8800, 15)]);
    expect(result).toEqual([
      { name: 'ITC Maurya', price: 8800, supplier: 'Supplier B', commissionPct: 15 },
    ]);
  });

  it('6. names differing only in case/whitespace collapse to one entry', () => {
    const result = selectBestOffers([h('Holtin', 6000)], [h('  hOLTIN ', 6500)]);
    expect(result).toHaveLength(1);
  });

  it("7. returned name is the winner's name, trimmed, original casing", () => {
    const result = selectBestOffers([h('Holtin', 6000)], [h('  hOLTIN ', 5000)]);
    expect(result[0]?.name).toBe('hOLTIN');
    expect(result[0]?.supplier).toBe('Supplier B');
  });

  it('8. duplicates within one supplier → cheaper kept', () => {
    const result = selectBestOffers([h('Holtin', 6000, 10), h('holtin', 5500, 9)], []);
    expect(result).toEqual([
      { name: 'holtin', price: 5500, supplier: 'Supplier A', commissionPct: 9 },
    ]);
  });

  it('9. exact tie within one supplier → first kept', () => {
    const result = selectBestOffers([], [h('First', 4000, 5), h(' FIRST', 4000, 7)]);
    expect(result).toEqual([
      { name: 'First', price: 4000, supplier: 'Supplier B', commissionPct: 5 },
    ]);
  });

  it('10. sorted by price ascending', () => {
    const result = selectBestOffers(
      [h('C', 300), h('A', 100)],
      [h('B', 200), h('D', 50)],
    );
    expect(result.map((o) => o.price)).toEqual([50, 100, 200, 300]);
  });

  it('11. equal prices → name ascending by code unit (not localeCompare)', () => {
    const result = selectBestOffers([h('alpha', 100)], [h('Zeta', 100)]);
    expect(result.map((o) => o.name)).toEqual(['Zeta', 'alpha']);
  });

  it('12. both inputs empty → []', () => {
    expect(selectBestOffers([], [])).toEqual([]);
  });

  it('13. one input empty → other list labelled and sorted', () => {
    const result = selectBestOffers([], [h('Y', 200, 3), h('X', 100, 4)]);
    expect(result).toEqual([
      { name: 'X', price: 100, supplier: 'Supplier B', commissionPct: 4 },
      { name: 'Y', price: 200, supplier: 'Supplier B', commissionPct: 3 },
    ]);
  });

  it('14. does not mutate inputs', () => {
    const a = [h('Holtin', 6000), h(' Taj ', 9000)];
    const b = [h('holtin', 5000), h('ITC', 8000)];
    const aCopy = structuredClone(a);
    const bCopy = structuredClone(b);
    const result = selectBestOffers(deepFreeze(a), deepFreeze(b));
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
    // output objects are new, not references to inputs
    for (const offer of result) {
      expect([...a, ...b]).not.toContain(offer);
    }
  });
});
