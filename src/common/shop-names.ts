/**
 * One name for each thing in the Record Shop (Jake approved the Record Shop
 * picture and the V7 plan's "One name for each thing", 2026-11-24). The phone
 * says the same words (the Mobile V3 plan's "Across both apps" section); a
 * word changed here is changed there too.
 *
 * shop-names.test.ts reads every screen's words and fails on a retired name,
 * so a new button can't bring one back.
 */

/** The words the shop says. */
export const SHOP_WORDS = {
  shop: 'Record Shop',
  list: 'Listening List',
  save: 'Save',
  saveAlbum: 'Save album',
  downloads: 'Downloads',
} as const

/** The shop's tabs, in order. */
export const SHOP_TAB_LABELS = ['For You', 'Search', SHOP_WORDS.list, 'Bandcamp'] as const

/** The sidebar's STORE section: these rows and no others. */
export const STORE_ROWS = [SHOP_WORDS.shop, SHOP_WORDS.downloads] as const

/** The mark on a result that is on the Listening List. */
export const LIST_MARK = `On your ${SHOP_WORDS.list}`

/**
 * Names the app never shows. Each was one of the shop's six names, or the
 * same action under another word.
 */
export const RETIRED_SHOP_NAMES = [
  'Listen List',
  'Listen to the List',
  'The Racks',
  'Bandcamp Store',
  'Get all',
  'your list',
] as const

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The retired names in some words a person reads, as whole words with their
 * case kept ("your lists" of playlists is another thing; "Listen" alone is a
 * verb).
 */
export function retiredNamesIn(words: string): string[] {
  return RETIRED_SHOP_NAMES.filter((n) => new RegExp(`\\b${escape(n)}\\b`).test(words))
}
