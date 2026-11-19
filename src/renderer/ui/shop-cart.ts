/**
 * Cart settlement of a checkout, kept free of DOM and store imports so the
 * partial-success rules are unit-testable.
 */

/** One keyed cart line: the cart row identity the settlement maps back to. */
export interface CartLine {
  key: string
}

/** Outcome of trying to buy one cart row. */
export interface CartSettlement {
  key: string
  ok: boolean
}

/**
 * Applies the per-line purchase outcomes to the cart: bought rows leave, failed
 * rows stay in their original order. A row with no outcome counts as failed —
 * an item is only removed once the authority accepted it.
 */
export function settleCartLines<T extends CartLine>(
  lines: readonly T[],
  settled: readonly CartSettlement[],
): { remaining: T[]; allOk: boolean } {
  const bought = new Set(settled.filter((entry) => entry.ok).map((entry) => entry.key))
  const remaining = lines.filter((line) => bought.has(line.key) === false)
  return { remaining, allOk: remaining.length === 0 }
}
