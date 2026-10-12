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
import { searchTitle, requestedVersionMarkers } from './streamrip-match.ts'
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
//
// Same shape as searchTitle's English rule (".*edition.*" unless a version
// marker): a group that names an EDITION is metadata whatever else it says —
// "Edición Diamante", "Zlatá edice", "Feest Editie" — unless it also names
// another RECORDING (live, acoustic, remix…) or VOLUME, which survives.
//
// The words come from real labels, not memory: a 2026-10-11 harvest of album
// titles from the iTunes catalog in 27 storefronts (ru ua br pt es mx ar fr
// it de nl se no dk fi pl cz hu ro tr gr il jp kr tw hk cn) plus the library,
// then 8 more (sa eg ae jo lb th in vn). There, the native "edition" word —
// نسخة/إصدار, ฉบับ, संस्करण, phiên bản — names VERSIONS (slow, acoustic,
// Hindi-language, female…: other recordings), so it is deliberately absent;
// only طبعة, Thai รีมาสเตอร์/ดีลักซ์ อิดิชั่น and loanwords (deluxe/remaster,
// Vietnamese tái bản) are edition words in those four languages.
//
// Arabic writes one word several ways — with or without short vowels and
// hamza (إِصْدَار / اصدار), ة or ه, ى or ي — so those fold away too. NFD
// has already split hamza-on-alef into alef + a mark in this range.
const editionFold = (w: string): string =>
  w.replace(/[ً-ٰٟـ]/g, '').replace(/ٱ/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
const foldList = (words: string): string[] => words.split(/\s+/).filter(Boolean).map((w) => editionFold(nameKey(w, '')))
const EDITION_WORDS = new Set(foldList(`
  deluxe edition editions remaster remastered remastering remasters anniversary expanded reissue reissued bonus
  edición ediciones reedición remasterizado remasterizada remasterizados remasterizadas remasterización aniversario ampliada ampliado conmemorativa conmemorativo
  edição edições reedição remasterização comemorativa comemorativo
  réédition remasterisé remasterisée remasterisés remasterisées remasterisation anniversaire augmentée
  edizione edizioni rimasterizzato rimasterizzata rimasterizzati rimasterizzate rimasterizzazione ristampa anniversario espansa
  neuauflage erweiterte remastert jubiläum
  geremasterd jubileum remastrad remastrade remastret jubilæum remasteroitu remasteroidut
  edycja wydanie zremasterowana zremasterowany zremasterowane rocznicowa rocznicowe jubileuszowa jubileuszowe
  edice edícia vydání remasterovaná remasterované remasterovaný výročí kiadás jubileumi
  ediție aniversară remasterizat remasterizată baskı
  έκδοση επανέκδοση
  издание издания переиздание делюкс ремастер ремастеринг ремастированная ремастированный ремастированное ремастированные
  юбилейное юбилейный юбилейная летие расширенное расширенная расширенный бонус
  видання перевидання ювілейне ювілейний ювілейна
  מהדורה מהדורת מהדורות דלוקס רמאסטר רימאסטר מורחבת בונוס
  طبعة ديلوكس ريماستر ريماسترد
  डीलक्स रीमास्टर रीमास्टर्ड
`))
// Two-word edition names in a language that spaces every syllable.
const EDITION_PHRASES = ['tái bản'].map((p) => nameKey(p))
// Thai runs words together: ขอจีบเธอได้ไหม(รีมาสเตอร์), ดีลักซ์ อิดิชั่น.
const EDITION_UNSPACED = new RegExp(foldList('รีมาสเตอร์ ดีลักซ์ อิดิชั่น เอดิชั่น ครบรอบ').join('|'))
// Compounds end in the edition noun: Jubiläumsausgabe, kersteditie,
// specialutgåva, juhlapainos, 十週年紀念版, 26周年スペシャルリマスター,
// 初回生産限定盤D, リマスター2017. (Not "expedition"/"expeditie".)
const EDITION_ENDING = new RegExp(`(?:(?<!exp)edition|(?<!exp)editie|${foldList(`
  ausgabe udgave utgave utgåva painos kiadás
  纪念版 紀念版 典藏版 珍藏版 豪华版 豪華版 限量版 限定版 修复版 修復版 重制版 重製版 复刻版 復刻版
  限定盤 通常盤 初回盤 リマスター盤 リマスター版 リマスター デラックス盤 デラックス版 デラックス エディション
  에디션 디럭스 리마스터 한정판
`).join('|')})[a-z0-9]*$`)
// Another recording (live, acoustic, remix… beyond searchTitle's English
// markers) or another VOLUME — "(Коллекционное издание, том 17)" is not
// volume 10. A group naming either stays.
const OTHER_RECORD = new Set(foldList(`
  vivo directo direct concierto concerto konzert koncert canlı ζωντανά
  acústico acústica acústicos acoustique akustisch akustik akustisk akustinen akustyczna
  remezcla remezclas remezclado remezclada remixé remixée remixado remixada remixato remixata geremixt remixt remiks
  sinfónico sinfônico sinfonico symphonique symfonisch instrumentale strumentale playback
  концерт концертная живой живьём акустика акустический акустическая ремикс ремиксы инструментал караоке ремікс
  הופעה חי חיה אקוסטי אקוסטית רמיקס
  لايف حفلة أكوستيك ريمكس ريميكس كاريوكي كوفر
  लाइव रीमिक्स अनप्लग्ड
  vol volume volumes volumen tom том part pt parte partie teil deel folge część část rész osa disc часть частина חלק כרך
`))
const OTHER_RECORD_UNSPACED = new RegExp(foldList(`
  ライブ アコースティック リミックス カラオケ インスト 라이브 어쿠스틱 리믹스 现场 現場 演唱会 演唱會 音乐会 音樂會 伴奏
  แสดงสด คอนเสิร์ต เสียงสด อะคูสติก รีมิกซ์ คาราโอเกะ
`).join('|'))

function isEditionGroup(body: string): boolean {
  const words = nameKey(body).split(' ').filter(Boolean).map(editionFold)
  const text = ` ${words.join(' ')} `
  const names = words.some((w) => EDITION_WORDS.has(w) || EDITION_ENDING.test(w) || EDITION_UNSPACED.test(w))
    || EDITION_PHRASES.some((p) => text.includes(` ${p} `))
  if (!names) return false
  if (requestedVersionMarkers(body).length > 0) return false
  return !words.some((w) => OTHER_RECORD.has(w) || OTHER_RECORD_UNSPACED.test(w))
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
 * before. The persisted keys keep recoNorm's shape (recoIdNorm: unaccented
 * Latin, byte for byte); this compare is never stored, so it folds accents.
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
