/**
 * 4.5.0-118 — New-music radar core (Discovery Brain Phase 2), pure + tested.
 *
 * The impure half (Exa search + claudeCall extraction) lives in the
 * get-new-music-radar IPC in index.ts; this is the deterministic half:
 * parse the LLM's candidate list, then rank it against the taste fingerprint
 * (drop owned, dedupe, score, sort). Pure so `node --test` drives it.
 */
import { scoreCandidateForRadar, norm } from './taste-model.ts'
import type { TasteFingerprint, TasteAnchor } from './taste-model.ts'
import { searchTitle } from './streamrip-match.ts'
import { nameKey } from '../common/fold-text.ts'

export interface RawCandidate { artist?: string; title?: string; genre?: string; year?: string | number; why?: string; anchor?: string }
export interface RankedCandidate {
  artist: string
  title: string
  genre: string
  year: string
  why: string
  anchor?: string
  score: number
  reasons: string[]
}

/** Tolerant parse of the LLM's JSON candidate list (handles code fences /
 *  surrounding prose by extracting the first [...] array). */
export function parseCandidates(text: string): RawCandidate[] {
  if (!text) return []
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence ? fence[1] : text).trim()
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(body.slice(start, end + 1))
    return Array.isArray(arr) ? (arr as RawCandidate[]) : []
  } catch {
    return []
  }
}

/** A Listen List row, as far as the radar's on-list guard reads it. */
export interface ListenListRow {
  song?: string
  artist?: string
  album?: string
  kind?: string
  matchedTitle?: string
  matchedArtist?: string
  matchedAlbum?: string
}

/** Does the list file this row under Albums? ⚠️ TWIN:
 *  renderer/listen-to-the-list/ltlDownload.ts recoKind ('album' or 'concert')
 *  and views/ListenToTheListView.tsx recoType — same rule, so the radar hides
 *  exactly the albums the list shows. */
function isAlbumRow(r: ListenListRow): boolean {
  if (r.kind === 'album' || r.kind === 'concert') return true
  const title = (r.matchedTitle || r.song || '').trim()
  const album = (r.matchedAlbum || r.album || '').trim()
  return !title && Boolean(album)
}

// Edition words in any language, for the radar's album compare ONLY.
// searchTitle (English) also builds download-search queries, so widening it
// would move what a Get asks Qobuz for; this list never leaves the radar.
// A word list, not phrases: a group is edition metadata when EVERY word is
// on it and at least one is a CORE word. "En Vivo", "Ao Vivo", "Acústico"
// are on neither, so a group naming another recording always survives.
const foldWords = (words: string): Set<string> => new Set(words.split(/\s+/).filter(Boolean).map((w) => nameKey(w, '')))
const EDITION_CORE = foldWords(`
  deluxe edition remaster remastered remastering anniversary expanded reissue bonus
  edición reedición remasterizado remasterizada remasterizados remasterizadas remasterización aniversario ampliada ampliado
  edição reedição comemorativa
  réédition remasterisé remasterisée remasterisés remasterisées anniversaire augmentée
  edizione rimasterizzato rimasterizzata rimasterizzati ristampa espansa
  ausgabe jubiläumsausgabe sonderausgabe neuauflage erweiterte remastert
  издание переиздание делюкс ремастер ремастеринг ремастированная ремастированный ремастированное юбилейное расширенное летие
  מהדורה מהדורת דלוקס רמאסטר רימאסטר מורחבת בונוס
  デラックス エディション リマスター リマスター盤 リマスター版 デラックス盤 デラックス版 限定盤 初回限定盤 初回生産限定盤 完全生産限定盤 期間生産限定盤 初回盤 通常盤
  디럭스 에디션 리마스터 한정판
  豪华版 豪華版 纪念版 紀念版 限量版 重制版 重製版 典藏版
`)
// Allowed beside a core word, never enough alone ("(Special)" is a title).
const EDITION_FILLER = foldWords(`
  version versión versão versione версия גרסה גרסת バージョン 버전
  special especial spéciale speciale spezial специальное מיוחדת スペシャル 스페셜
  limited limitada limitée limitata limitierte ограниченное מוגבלת
  collector collectors s super digital track tracks коллекционное подарочное
  years year años anos ans anni jahre лет שנה
  the and de del la el los las da do dos di des du d l der die das und y e et
`)
const ORDINAL = /^\d+(?:st|nd|rd|th|e|er|eme|o|a)?$/

function isEditionGroup(body: string): boolean {
  const words = nameKey(body).split(' ').filter(Boolean)
  return words.some((w) => EDITION_CORE.has(w))
    && words.every((w) => EDITION_CORE.has(w) || EDITION_FILLER.has(w) || ORDINAL.test(w))
}

/** Drop bracketed or " - " trailing edition groups, in any language. Returns
 *  the title unchanged when nothing (or everything) would be left. */
export function stripEditionWords(title: string): string {
  const out = title
    .replace(/\s*[([{【（]([^()[\]{}【】（）]*)[)\]}】）]/g, (whole, body: string) => (isEditionGroup(body) ? '' : whole))
    .replace(/^(.*\S)\s+[-–—]\s+(.+)$/, (whole, head: string, tail: string) => (isEditionGroup(tail) ? head : whole))
    .replace(/\s{2,}/g, ' ')
    .trim()
  return out || title.trim()
}

/**
 * The `isOnList` predicate for rankCandidates, built from the Listen List
 * rows: song|artist from the same fields the list keys by (raw fields first,
 * iTunes-matched as fallback). ⚠️ The key is SONG first — the radar hands us
 * (artist, title), so it must be flipped. index.ts passed (artist, title)
 * straight into a (song, artist) key and the guard never matched (2026-10-11).
 *
 * Names fold through nameKey, not recoNorm: recoNorm's [^a-z0-9] erased every
 * Hebrew/Cyrillic/CJK title (no key, so never hidden) and dropped accented
 * letters ("Ágætis byrjun" ≠ "Agaetis Byrjun"). A-Z names key exactly as
 * before. recoNorm stays on the persisted keys; this compare is never stored.
 *
 * The radar's "title" is a RELEASE, so album rows key their album the same
 * way (album|artist, raw names, then the iTunes ones). A song row that names
 * its album doesn't hide the album — one saved song isn't the record.
 *
 * Albums compare WITHOUT edition words on both sides (searchTitle — the
 * same strip albumKey uses): "Rat Saw God (Deluxe Edition)" on the list
 * hides "Rat Saw God", and "- EP"/"- Single" fall away. "(Live)"/"(Remix)"
 * survive — those are other recordings. This is a hide-from-radar compare,
 * never stored; the persisted identity keys keep editions apart. Edition
 * words in other languages go first (stripEditionWords): "Этажи (Делюкс)",
 * "(Edición Aniversario)", "【初回限定盤】".
 */
export function listenListPredicate(records: ListenListRow[]): (artist: string, title: string) => boolean {
  const songKeys = new Set<string>()
  const albumKeys = new Set<string>()
  const pairKey = (name: string | undefined, artist: string | undefined): string | null => {
    const n = nameKey(name, '')
    const a = nameKey(artist, '')
    return n && a ? `${n}|${a}` : null
  }
  const albumKey = (album: string | undefined, artist: string | undefined): string | null => {
    const base = album && stripEditionWords(album)
    return pairKey(base && (searchTitle(base) || base), artist)
  }
  const add = (set: Set<string>, k: string | null): void => { if (k) set.add(k) }
  for (const r of records) {
    add(songKeys, pairKey(r.song || r.matchedTitle, r.artist || r.matchedArtist))
    if (isAlbumRow(r)) {
      add(albumKeys, albumKey(r.album || r.matchedAlbum, r.artist || r.matchedArtist))
      add(albumKeys, albumKey(r.matchedAlbum, r.matchedArtist))
    }
  }
  return (artist, title) => {
    const song = pairKey(title, artist)
    if (song != null && songKeys.has(song)) return true
    const album = albumKey(title, artist)
    return album != null && albumKeys.has(album)
  }
}

/**
 * Rank raw candidates against the taste fingerprint: drop entries missing
 * artist/title, dedupe by artist+title, drop artists the user already OWNS
 * (this is discovery), drop anything already on the user's list (optional
 * `isOnList` predicate — keeps the radar from re-suggesting a saved jot),
 * score the rest, sort high→low, take top `limit`.
 */
export function rankCandidates(
  fp: TasteFingerprint,
  raw: RawCandidate[],
  limit = 12,
  isOnList?: (artist: string, title: string) => boolean,
  anchors: TasteAnchor[] = [],
): RankedCandidate[] {
  const seen = new Set<string>()
  const out: RankedCandidate[] = []
  for (const c of raw) {
    const artist = (c.artist ?? '').toString().trim()
    const title = (c.title ?? '').toString().trim()
    if (!artist || !title) continue
    const key = `${norm(artist)}|${norm(title)}`
    if (seen.has(key)) continue
    seen.add(key)
    if (isOnList && isOnList(artist, title)) continue
    const s = scoreCandidateForRadar(fp, { artist, genre: c.genre, year: c.year, anchor: c.anchor, why: c.why }, anchors)
    if (s.owned) continue
    out.push({
      artist,
      title,
      genre: (c.genre ?? '').toString().trim(),
      year: (c.year ?? '').toString().trim(),
      why: (c.why ?? '').toString().trim(),
      anchor: (c.anchor ?? '').toString().trim() || undefined,
      score: s.score,
      reasons: s.reasons,
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, Math.max(0, limit))
}
