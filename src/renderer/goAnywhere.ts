/**
 * ⌘K "Go anywhere" (V7): one bar that opens any page, artist, album,
 * playlist, iPod, concert or setting by name, and plays it on ⌘Return.
 * The pure part (the list and the ranking) lives here and is tested in
 * src/main/__tests__/go-anywhere.test.ts; components/GoAnywhere.tsx draws it.
 */

export type GoKind = 'page' | 'artist' | 'album' | 'playlist' | 'ipod' | 'concert' | 'setting'

export type GoTarget =
  | { kind: 'page'; view: string }
  | { kind: 'artist'; name: string }
  | { kind: 'album'; key: string }
  | { kind: 'playlist'; id: string; smart: boolean }
  | { kind: 'ipod'; playlistId: string }
  | { kind: 'concert'; albumKey: string; trackId: number }
  | { kind: 'setting'; tab: string }

export interface GoItem {
  title: string
  /** The grey words after it: the artist of an album, "Page", "Setting"… */
  detail: string
  target: GoTarget
  /** Can ⌘Return play it? Pages and settings only open. */
  playable: boolean
  /** Folded words to match against (title + detail). */
  hay: string
}

/** Lower-case, accents off, punctuation to spaces: "Beyoncé — 4" → "beyonce 4". */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Every page a key or the sidebar opens. Labels as the sidebar prints them. */
export const GO_PAGES: readonly { title: string; view: string; also?: string }[] = [
  { title: 'Home', view: 'home' },
  { title: 'Songs', view: 'songs' },
  { title: 'Albums', view: 'albums' },
  { title: 'Artists', view: 'artists' },
  { title: 'Live Albums', view: 'concerts', also: 'live concerts recordings' },
  { title: 'Genres', view: 'genres' },
  { title: 'Record Shop', view: 'discovery', also: 'store discovery' },
  { title: 'Listening List', view: 'listen-to-the-list', also: 'listen to the list inbox recommendations' },
  { title: 'New for You', view: 'new-for-you' },
  { title: 'Top 1000 Quiz', view: 'top1000' },
  { title: 'The Music Man', view: 'musicman' },
  { title: 'DJ', view: 'dj', also: 'booth decks' },
  { title: 'Year in Review', view: 'year-in-review' },
  { title: 'Rock DNA', view: 'rock-dna' },
  { title: 'iPod', view: 'device', also: 'device sync' },
  { title: 'Import CD', view: 'cd-import', also: 'rip' },
]

/** The Preferences tabs (components/SettingsModal.tsx TABS). */
export const GO_SETTINGS: readonly string[] = ['Playback', 'EQ', 'Library', 'Music Sources', 'Backups', 'Storage', 'Audio', 'AI']

export interface GoSources {
  artists: readonly { name: string }[]
  albums: readonly { key: string; album: string; artist: string }[]
  playlists: readonly { id: string; name: string }[]
  smartPlaylists: readonly { id: string; name: string }[]
  ipods: readonly { playlistId: string; name: string }[]
  concerts: readonly { albumKey: string; band: string; show: string; trackId: number }[]
}

export function buildGoItems(src: GoSources): GoItem[] {
  const out: GoItem[] = []
  const add = (title: string, detail: string, target: GoTarget, playable: boolean, extra = ''): void => {
    if (!title.trim()) return
    out.push({ title, detail, target, playable, hay: fold(`${title} ${detail} ${extra}`) })
  }
  for (const p of GO_PAGES) add(p.title, 'Page', { kind: 'page', view: p.view }, false, p.also)
  for (const t of GO_SETTINGS) add(`${t} Settings`, 'Preferences', { kind: 'setting', tab: t }, false, 'settings preferences')
  for (const i of src.ipods) add(i.name, 'iPod', { kind: 'ipod', playlistId: i.playlistId }, true)
  for (const p of src.playlists) add(p.name, 'Playlist', { kind: 'playlist', id: p.id, smart: false }, true)
  for (const p of src.smartPlaylists) add(p.name, 'Playlist', { kind: 'playlist', id: p.id, smart: true }, true)
  for (const c of src.concerts) add(c.show, `${c.band} · Live`, { kind: 'concert', albumKey: c.albumKey, trackId: c.trackId }, true)
  for (const a of src.artists) add(a.name, 'Artist', { kind: 'artist', name: a.name }, true)
  for (const a of src.albums) add(a.album, a.artist, { kind: 'album', key: a.key }, true)
  return out
}

// A tie between equally good matches goes to the thing more people mean.
const KIND_RANK: Record<GoKind, number> = { page: 0, ipod: 1, playlist: 2, artist: 3, album: 4, concert: 5, setting: 6 }

/**
 * How well `item` answers the words typed (higher is better; 0 = no match).
 * Every word must be found. The title starting with the whole query beats a
 * word of the title starting with it, which beats the words found anywhere.
 */
export function goScore(item: GoItem, query: string): number {
  const q = fold(query)
  if (!q) return 0
  const words = q.split(' ')
  if (!words.every((w) => item.hay.includes(w))) return 0
  const title = fold(item.title)
  if (title === q) return 400
  if (title.startsWith(q)) return 300
  if (words.every((w) => title.split(' ').some((tw) => tw.startsWith(w)))) return 200
  if (words.every((w) => title.includes(w))) return 150
  return 100
}

/** The best `limit` items for the query, best first. */
export function searchGo(items: readonly GoItem[], query: string, limit = 12): GoItem[] {
  const scored: { item: GoItem; score: number }[] = []
  for (const item of items) {
    const score = goScore(item, query)
    if (score > 0) scored.push({ item, score })
  }
  scored.sort((a, b) =>
    b.score - a.score
    || KIND_RANK[a.item.target.kind] - KIND_RANK[b.item.target.kind]
    || a.item.title.length - b.item.title.length
    || a.item.title.localeCompare(b.item.title))
  return scored.slice(0, limit).map((s) => s.item)
}

/** What Return and ⌘Return do with the row under the cursor. */
export function goAction(item: GoItem, play: boolean): 'open' | 'play' {
  return play && item.playable ? 'play' : 'open'
}
