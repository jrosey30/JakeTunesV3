/**
 * ⚠️ TWIN: core/repair_mismatches.py::normalize
 * They MUST stay in lockstep. If you change this function, update the Python
 * twin in the SAME commit.
 */
const ROMAN_NUMERALS: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
}

export function normalize(s: unknown): string {
  let str = String(s || '')
  str = str.replace(/^\s*\d{1,2}\s*[-._]\s*/, '')
  str = str.replace(/\s*\b(feat(?:uring)?|ft)\b\.?[^)]*/ig, '')
  str = str.replace(/\bp(?:ar)?t\.?\s+([ivx]+|\d+)\b/gi, (m: string, suf: string) => {
    const k = suf.toLowerCase()
    if (/^\d+$/.test(k)) return `part ${k}`
    const n = ROMAN_NUMERALS[k]
    return n != null ? `part ${n}` : m
  })
  str = str.replace(/[()[\]{}"',.\-!?:;#/\\]+/g, ' ')
  return str.replace(/\s+/g, ' ').trim().toLowerCase()
}
