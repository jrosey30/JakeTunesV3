/**
 * Fold a name to plain ASCII letters before comparing it to another name.
 *
 * Jake, 2026-08-09, typing "JAY-Z" into Download and getting "Nothing matched
 * that": iTunes spells him JAŸ-Z, with U+0178, and every normaliser in the
 * download path stripped anything outside [a-z0-9]. So "JAŸ-Z" became "ja z",
 * the query "jay z" never matched it, every result scored zero, and a search
 * that returned ten correct rows rendered an empty page.
 *
 * It was never about JAY-Z. Measured on the same normalisers:
 *
 *     Beyoncé      -> "beyonc"        Björk      -> "bj rk"
 *     Sigur Rós    -> "sigur r s"     Motörhead  -> "mot rhead"
 *     Céline Dion  -> "c line dion"   JAŸ-Z      -> "ja z"
 *
 * Every one of those is unfindable and unmatchable. Two steps are needed and
 * the second is the one people forget:
 *
 *  1. NFD decomposition splits a letter from its accent, so the combining mark
 *     can be dropped and "é" becomes "e".
 *  2. Some letters have NO decomposition — ø, æ, ß, ł, đ, þ are single
 *     codepoints, not letter-plus-mark — so NFD alone leaves them to be
 *     stripped to nothing. They need an explicit map.
 *
 * ⚠️ TWIN: src/renderer/utils/searchIndex.ts (normalize) does step 1 only.
 * That is why universal search finds Beyoncé but Download did not.
 */

/** Letters with no NFD decomposition. Without these, step 1 silently misses. */
const SINGLETONS: Record<string, string> = {
  ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe',
  ß: 'ss', ł: 'l', Ł: 'l', đ: 'd', Đ: 'd', ð: 'd', Ð: 'd',
  þ: 'th', Þ: 'th', ı: 'i', İ: 'i', ŋ: 'n', ħ: 'h',
  ٱ: 'ا',   // Arabic alef wasla: no decomposition, folds like the other alefs
  // Arabic alef maksura → yeh and teh marbuta → heh (2026-10-12): the
  // standard Arabic search folds (Lucene's ArabicNormalizer does both).
  // Written forms vary, "مصطفى"/"مصطفي", "فاطمة"/"فاطمه". Unlike the
  // marks these change a LETTER, so a few distinct words now share a key
  // (على "on" and علي "Ali" — pinned in the tests). Jake's call, for matching.
  ى: 'ي', ة: 'ه',
}

/**
 * Arabic diacritics (2026-10-11): the harakat (short vowels, tanwin, shadda,
 * sukun, superscript alef), the honorific and Quranic marks, and the hamza
 * and madda that NFD splits off their seat. So "مُحَمَّد" is "محمد", and
 * أ إ آ fold to ا, ؤ to و, ئ to ي, the way é folds to e. Like Latin accents
 * they are optional in written Arabic, so one name came out two ways.
 */
const ARABIC_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g

/**
 * Hebrew niqqud and cantillation (2026-10-11): vowel points, dagesh, the
 * shin/sin dots, and the te'amim. Optional in written Hebrew, the same as the
 * harakat, so "שָׁלוֹם" is "שלום". The four non-marks in the block stay out:
 * maqaf ־ (a hyphen, already a word break), paseq, sof pasuq, nun hafukha.
 * Presentation forms (שׁ U+FB2A) reach here already split by NFKC.
 */
const HEBREW_MARKS = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g

/**
 * Diacritics folded, case dropped, everything else left exactly as it was —
 * callers still apply their own punctuation rules on top. Folding must happen
 * BEFORE any [a-z0-9] strip, or the accented letter is already gone.
 */
export function foldAccents(s: string | null | undefined): string {
  if (!s) return ''
  let out = ''
  for (const ch of String(s)) {
    out += SINGLETONS[ch] ?? ch
  }
  return out
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(ARABIC_MARKS, '')
    .replace(HEBREW_MARKS, '')
    .toLowerCase()
}

/**
 * What a name key drops: anything that isn't a letter, mark or digit, AND the
 * spacing modifier letters U+02B0–U+02FF. Those are letters to Unicode (Lm)
 * but apostrophes and primes in practice: ʼ (U+02BC) is the apostrophe in
 * "Donʼt" and in Ukrainian, ʻ the okina in "Hawaiʻi", ʹ ʾ ʿ the primes and
 * ayin/hamza of transliteration. Kept as letters, "Donʼt" never met "Don't"
 * (2026-10-11). Only that block: Japanese ー and 々 are Lm too, and they are
 * part of the word.
 */
const NOT_NAME = /(?:[^\p{L}\p{M}\p{N}]|[\u02B0-\u02FF])+/gu

/**
 * The Arabic tatweel (U+0640, kashida): a stretch line for justification,
 * not a letter of the word — "عـربي" IS "عربي". Unicode calls it a letter and
 * NFKC keeps it, so it is DELETED before folding (separating it, as the
 * apostrophes are, would split one word in two) (2026-10-11).
 */
const TATWEEL = /\u0640/g

/**
 * THE identity/matching key for a name, in any script: accents folded
 * (foldAccents, after NFKC so full-width and ligature forms fold too), case
 * dropped, letters + marks + digits of EVERY script kept, each run of
 * anything else turned into one `sep` (' ' by default; '' squashes).
 *
 * Why every script (2026-10-11): `[^a-z0-9]` deleted every Hebrew, Cyrillic,
 * Greek, Arabic and CJK letter, so all those names became the SAME empty key —
 * Молчат Дома inherited an Israeli band's origin, every all-Hebrew song was one
 * song in the listening history, and every Hebrew album shared one cover.
 * One helper so the folds stop drifting apart.
 */
export function nameKey(s: string | null | undefined, sep = ' '): string {
  if (!s) return ''
  const k = foldAccents(String(s).normalize('NFKC').replace(TATWEEL, '')).replace(NOT_NAME, ' ').trim()
  return sep === ' ' ? k : k.replace(/ /g, sep)
}

/** A letter from a script other than Latin — the letters `[^a-z0-9]` erased. */
const OTHER_SCRIPT = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u
export function hasOtherScript(s: string | null | undefined): boolean {
  return !!s && OTHER_SCRIPT.test(String(s))
}

/**
 * For a key that is ALREADY STORED under an ASCII-only fold (verdict
 * ledgers, caches): a Latin-script name keeps its `legacy` key byte for
 * byte, so nothing on disk is orphaned; a name with letters of another
 * script — which the legacy fold erased — gets nameKey. Those names never
 * had a working key, so there is nothing of theirs to orphan.
 */
export function storedNameKey(s: string | null | undefined, legacy: (s: string) => string): string {
  return hasOtherScript(s) ? nameKey(s) : legacy(String(s ?? ''))
}

/**
 * Is `a` within `max` edits of `b`? Bounded Levenshtein with an early exit.
 *
 * Needed because iTunes ALREADY corrects a typo — "radiohed" returns Radiohead,
 * "beyonce" returns Beyoncé — and then our own scorer threw the right answer
 * away, because "radiohed" is not a substring of "radiohead" and nothing else
 * matched. Apple did the hard part and we deleted the result.
 */
export function withinEditDistance(a: string, b: string, max: number): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > max) return false
  const m = a.length, n = b.length
  let prev = new Array<number>(n + 1)
  let cur = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    let best = cur[0]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      if (cur[j] < best) best = cur[j]
    }
    if (best > max) return false          // whole row already too far
    const t = prev; prev = cur; cur = t
  }
  return prev[n] <= max
}

/** Edits allowed for a word of this length — 1 for short, 2 from 7 chars up.
 *  Anything looser starts matching genuinely different words. */
export function typoBudget(len: number): number {
  if (len <= 3) return 0
  if (len <= 6) return 1
  return 2
}
