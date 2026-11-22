import type { BestOffer, SupplierHotel, SupplierName } from './types';

/** Dedupe key: trimmed + lowercased name. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Plain code-unit comparison (not localeCompare), so equal-price ordering
 * matches Redis's lexicographic ordering of sorted-set members.
 *
 * Note: Redis compares UTF-8 bytes while JS compares UTF-16 code units.
 * These agree for ASCII and most of the BMP; they can differ only for
 * characters >= U+E000 vs astral (surrogate-pair) characters. Out of scope
 * for this project's data.
 */
function compareNames(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Pure: merges both suppliers' lists, keeps the cheapest offer per hotel
 * (dedupe key = trimmed + lowercased name), and sorts by price ascending,
 * then name ascending.
 *
 * - Cross-supplier price tie → Supplier A (A is processed first; B replaces
 *   only when strictly cheaper).
 * - Duplicates within one supplier → cheaper wins; exact tie → first one.
 * - Name and commission come from the winning offer; name is trimmed with
 *   original casing.
 *
 * Inputs are never mutated. O((n + m) log(n + m)) time, O(k) space.
 */
export function selectBestOffers(
  a: readonly SupplierHotel[],
  b: readonly SupplierHotel[],
): BestOffer[] {
  const best = new Map<string, BestOffer>();

  const consider = (list: readonly SupplierHotel[], supplier: SupplierName): void => {
    for (const hotel of list) {
      const key = normalizeName(hotel.name);
      const current = best.get(key);
      if (current === undefined || hotel.price < current.price) {
        best.set(key, {
          name: hotel.name.trim(),
          price: hotel.price,
          supplier,
          commissionPct: hotel.commissionPct,
        });
      }
    }
  };

  consider(a, 'Supplier A');
  consider(b, 'Supplier B');

  return [...best.values()].sort(
    (x, y) => x.price - y.price || compareNames(x.name, y.name),
  );
}
