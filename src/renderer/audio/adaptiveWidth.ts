/**
 * adaptiveWidth — the pure decision behind audioEnhance's adaptive pass
 * (2026-09-02). Kept howler-free so it can be unit-tested under node.
 *
 * The configured mid/high widths are CEILINGS. Per band, the source's own
 * L/R correlation decides how much of the ceiling applies: a band that
 * already measures wide (≤ ADAPT_WIDE_CORR) is left alone; a narrow one
 * (≥ ADAPT_NARROW_CORR) gets the full ceiling; in between, proportionally.
 * Ceilings ≤ 1 (mono bass) are not adaptive — they always apply.
 */
export const ADAPT_WIDE_CORR = 0.4
export const ADAPT_NARROW_CORR = 0.9

export function adaptiveWidthFor(ceiling: number, corr: number): number {
  if (!(ceiling > 1)) return ceiling
  const c = Number.isFinite(corr) ? corr : 1
  const k = Math.max(0, Math.min(1, (c - ADAPT_WIDE_CORR) / (ADAPT_NARROW_CORR - ADAPT_WIDE_CORR)))
  return 1 + (ceiling - 1) * k
}
