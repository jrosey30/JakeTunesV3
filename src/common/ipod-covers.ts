/**
 * Each iPod list wears the iPod it lives on (2026-11-09). Jake: "the playlist
 * photos should be their respective ipods. so silver ipod mini is the top 1000.
 * red ipod mini is the punkpod. if i dont have one use a default ipod photo to
 * which i can customize color".
 *
 * The covers are DRAWN (JakeTunesMobile tools/make-playlist-covers.py), one
 * picture per (model, colour): the named colours ship with this app
 * (renderer/assets/ipod-covers/<model>-<colour>.jpg); a custom colour is drawn
 * by homemini (GET /api/playlist-cover/ipod/:model/:hex) and kept on this Mac.
 *
 * Which colour, on the MacBook (the hub): Jake's choice made on this Mac, then
 * a registered iPod's registry colour, then the list's colour on homemini, then
 * the model's own default. On a replica: the list's colour.
 *
 * Pure — node --test loads it.
 *
 * ⚠️ TWIN: the colour table, the model names and normalize are
 * JakeTunesMobile tools/make-playlist-covers.py (IPOD_COLORS,
 * normalize_ipod_color, ipod_cover_name) and backend/src/util/ipodCovers.ts.
 * Change all three together.
 */

export const IPOD_MODELS = ['mini', 'classic', '3g', 'default'] as const
export type IpodModel = (typeof IPOD_MODELS)[number]

/** Real iPod mini / nano / classic colours, in palette order. */
export const IPOD_COLORS: ReadonlyArray<{ name: string; hex: string }> = [
  { name: 'silver', hex: '#d5d7da' },
  { name: 'gold', hex: '#dcc694' },
  { name: 'pink', hex: '#ef9fbc' },
  { name: 'blue', hex: '#6fa9de' },
  { name: 'green', hex: '#9fcf73' },
  { name: 'red', hex: '#c51f2e' },
  { name: 'purple', hex: '#8b68c4' },
  { name: 'orange', hex: '#f0862a' },
  { name: 'yellow', hex: '#f2d14a' },
  { name: 'black', hex: '#2c2c2f' },
  { name: 'white', hex: '#f3f2ee' },
]

const NAMED = new Map(IPOD_COLORS.map((c) => [c.name, c.hex]))

export const IPOD_DEFAULT_COLOR: Readonly<Record<IpodModel, string>> = {
  mini: 'silver', classic: 'silver', '3g': 'white', default: 'white',
}

/** The Original (Top 1000's iPod) is a silver iPod mini. */
export const ORIGINAL_MODEL: IpodModel = 'mini'
export const ORIGINAL_COLOR = 'silver'

export function isIpodModel(v: unknown): v is IpodModel {
  return typeof v === 'string' && (IPOD_MODELS as readonly string[]).includes(v)
}

export function isNamedIpodColor(c: string): boolean {
  return NAMED.has(c)
}

/** 'Red ' → 'red', '#C51F2E' → '#c51f2e'; anything else → null. */
export function normalizeIpodColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (NAMED.has(s)) return s
  return /^#[0-9a-f]{6}$/.test(s) ? s : null
}

/** A colour's '#rrggbb' (a named colour's table value). */
export function ipodColorHex(color: string): string {
  return NAMED.get(color) ?? color
}

/** The named colour closest to a hex (squared RGB distance; ties go to table order). A name is itself. */
export function nearestIpodColor(color: string): string {
  if (NAMED.has(color)) return color
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [r, g, b] = rgb(color)
  let best = IPOD_COLORS[0].name
  let bestD = Infinity
  for (const c of IPOD_COLORS) {
    const [cr, cg, cb] = rgb(c.hex)
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    if (d < bestD) { bestD = d; best = c.name }
  }
  return best
}

/** The file a cover is kept under: 'mini-red', 'classic-c51f2e'. */
export function ipodCoverKey(model: IpodModel, color: string): string {
  return `${model}-${color.replace(/^#/, '')}`
}

export interface IpodLook { model: IpodModel; color: string }

/**
 * The iPod a list wears. Colour: `chosen` (Jake picked it on this Mac), then a
 * registered iPod's `registryColor`, then the list's colour, then the model's
 * default. Anything that doesn't normalize is skipped. No model → 'default'.
 */
export function ipodLook(input: {
  model?: unknown
  listColor?: unknown
  registryColor?: unknown
  registered?: boolean
  chosen?: unknown
}): IpodLook {
  const model = isIpodModel(input.model) ? input.model : 'default'
  const color = normalizeIpodColor(input.chosen)
    ?? (input.registered ? normalizeIpodColor(input.registryColor) : null)
    ?? normalizeIpodColor(input.listColor)
    ?? IPOD_DEFAULT_COLOR[model]
  return { model, color }
}

/** Top 1000's iPod: the Original, a mini — in its registry colour when it has a good one, else silver. */
export function top1000Look(originalRegistryColor: unknown): IpodLook {
  return { model: ORIGINAL_MODEL, color: normalizeIpodColor(originalRegistryColor) ?? ORIGINAL_COLOR }
}

export interface IpodCoverChoice {
  /** The bundled picture to show now: always one of the named set. */
  bundledKey: string
  /** A custom colour: the exact picture to ask homemini for (and keep). null = the bundled one is exact. */
  fetchKey: string | null
}

/** Which picture a look shows: a named colour is bundled; a custom one shows its nearest named colour until homemini's arrives. */
export function ipodCoverChoice(look: IpodLook): IpodCoverChoice {
  if (NAMED.has(look.color)) return { bundledKey: ipodCoverKey(look.model, look.color), fetchKey: null }
  return { bundledKey: ipodCoverKey(look.model, nearestIpodColor(look.color)), fetchKey: ipodCoverKey(look.model, look.color) }
}

/** homemini's path for a look's picture (the hex without '#'). */
export function ipodCoverPath(look: IpodLook): string {
  return `/api/playlist-cover/ipod/${look.model}/${look.color.replace(/^#/, '')}`
}

/** A cache key the app may ask for: '<model>-<name|6 hex>'. Anything else → null (it names a file). */
export function parseIpodCoverKey(key: unknown): IpodLook | null {
  if (typeof key !== 'string') return null
  const m = /^(mini|classic|3g|default)-([a-z]+|[0-9a-f]{6})$/.exec(key)
  if (!m) return null
  const color = NAMED.has(m[2]) ? m[2] : /^[0-9a-f]{6}$/.test(m[2]) ? `#${m[2]}` : null
  return color ? { model: m[1] as IpodModel, color } : null
}
