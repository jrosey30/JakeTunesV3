/**
 * The 2026-10-28 genre audit, applied once (Jake: "make sure genres are
 * CORRECT"). The table itself is genre-corrections-data.ts — every row
 * grounded in MusicBrainz tags, Deezer's filing of the album, and the
 * sound-alike vote over his own shelves (the audit script and its evidence
 * are in the PR). This module only applies it, through the filer's own
 * persist path, and only where it is still true:
 *
 *   1. Back up metadata-overrides.json (flushed first). No backup, no pass.
 *   2. Seed the provenance record from the filer's own log: albums it filed
 *      before genre-provenance.json existed, still wearing that pick and
 *      never re-set by him, become the filer's — so it can re-judge them and
 *      they stop counting as his. Same for the check-list albums that wear
 *      the filer's old suggestion with no filedAs mark.
 *   3. Put back his own Get Info choices the filer filed over (the journal
 *      has his value and time; the song must still wear the filer's word).
 *   4. Corrections, per song still wearing the audited genre:
 *        his (Get Info, phone, a check-list File) → untouched, not even listed;
 *        nobody recorded who (treated as his) → never written; a
 *          high-confidence one goes on his check list as a suggestion (review);
 *        the filer's or the store's → high confidence: filed; medium: filed
 *          under the suggestion and put on the check list (filedAs), so he
 *          can Keep or File it.
 *   5. A marker (genre-corrections-applied.json) records what happened; a
 *      second run finds it and does nothing. Every change is logged.
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normName } from './taste-profile.ts'
import { GENRE_NAMES } from '../common/genre-vocab.ts'
import { EVIDENCE_VERSION, isSettled, trackFingerprint, type CheckEntry, type FilerDeps, type FilerTrack } from './genre-filer.ts'
import { isHis, sameSong, type FilerHow, type ProvenanceDoc } from './genre-provenance.ts'
import { CORRECTIONS_ID, SEEDS, RESTORES, CORRECTIONS, type Correction } from './genre-corrections-data.ts'

export const MARKER_FILE = 'genre-corrections-applied.json'

export interface CorrectionsDeps extends Pick<FilerDeps, 'tracks' | 'persist' | 'applied' | 'loadCheck' | 'saveCheck' | 'log' | 'now'> {
  userData: string
  flushOverrides?(): Promise<void>
  updateProvenance(mutate: (doc: ProvenanceDoc) => void): Promise<void>
  /** Test seam: the table (defaults to genre-corrections-data.ts). */
  table?: { id: string; seeds: typeof SEEDS; restores: typeof RESTORES; corrections: Correction[] }
}

export interface CorrectionsResult {
  ran: boolean
  seeded: number
  restored: number
  applied: Array<{ artist: string; album: string; from: string; to: string; songs: number }>
  listed: Array<{ artist: string; album: string; from: string; to: string; songs: number; review: boolean }>
  skipped: Array<{ artist: string; album: string; reason: string }>
}

const albumKey = (artist: string, album: string): string => `album:${normName(artist)}|${normName(album)}`
const keyOf = (t: FilerTrack): string => albumKey((t.albumArtist || t.artist || '').trim(), t.album || '')

export async function runGenreCorrections(deps: CorrectionsDeps): Promise<CorrectionsResult> {
  const table = deps.table ?? { id: CORRECTIONS_ID, seeds: SEEDS, restores: RESTORES, corrections: CORRECTIONS }
  const result: CorrectionsResult = { ran: false, seeded: 0, restored: 0, applied: [], listed: [], skipped: [] }
  const markerPath = join(deps.userData, MARKER_FILE)
  try {
    const m = JSON.parse(await readFile(markerPath, 'utf8')) as { id?: string }
    if (m.id === table.id) return result
  } catch { /* never ran */ }
  const log = (s: string): void => deps.log?.(`[genre-corrections] ${s}`)
  const now = (deps.now ?? (() => new Date()))()

  // 1. Backup first, or nothing.
  await deps.flushOverrides?.()
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  const src = join(deps.userData, 'metadata-overrides.json')
  const backup = `${src}.bak-genre-audit-${stamp}`
  try { await copyFile(src, backup) } catch (err) {
    log(`no backup of metadata-overrides.json (${err instanceof Error ? err.message : String(err)}) — pass not run`)
    return result
  }
  log(`backed up the edits file to ${backup}`)
  result.ran = true

  // 2. Seed: the filer's pre-record picks, still worn, never re-set by him.
  let tracks = await deps.tracks()
  const byAlbum = (artist: string, album: string): FilerTrack[] => { const k = albumKey(artist, album); return tracks.filter((t) => keyOf(t) === k) }
  const check = await deps.loadCheck()
  const seedRows: Array<{ id: number; genre: string; fp: string; how: FilerHow | 'check-list' }> = []
  for (const s of table.seeds) {
    for (const t of byAlbum(s.artist, s.album)) {
      if (t.genreBy !== 'unknown' || (t.genre || '').trim() !== s.genre) continue
      seedRows.push({ id: t.id, genre: s.genre, fp: trackFingerprint(t), how: s.how })
    }
  }
  for (const c of check) {
    if (c.filedAs || c.review || !c.suggested) continue
    for (const id of c.ids) {
      const t = tracks.find((x) => x.id === id)
      if (!t || t.genreBy !== 'unknown' || (t.genre || '').trim() !== c.suggested) continue
      seedRows.push({ id, genre: c.suggested, fp: trackFingerprint(t), how: 'suggestion' })
    }
  }
  if (seedRows.length) {
    const at = now.toISOString()
    await deps.updateProvenance((doc) => {
      for (const r of seedRows) {
        const cur = doc.tracks[String(r.id)]
        if (cur && cur.genre === r.genre && sameSong(cur.fp, r.fp)) continue
        doc.tracks[String(r.id)] = { genre: r.genre, by: 'filer', how: r.how, fp: r.fp, at, ...(r.how === 'suggestion' ? { confidence: 'low' as const } : {}) }
      }
    })
    result.seeded = seedRows.length
    log(`provenance: ${seedRows.length} song(s) marked as the filer's own earlier picks`)
    tracks = await deps.tracks()
  }

  // 3. His Get Info choices the filer filed over: put back.
  const updates: Array<{ trackId: number; field: string; newValue: string }> = []
  for (const r of table.restores) {
    const t = tracks.find((x) => x.id === r.id)
    if (!t || (t.genre || '').trim() !== r.from || isHis(t.genreBy) && t.genreBy !== 'unknown') continue
    if (trackFingerprint(t) !== r.fp) { result.skipped.push({ artist: r.artist, album: r.album, reason: `song ${r.id} changed since the audit` }); continue }
    await deps.persist(t, { genre: r.to })   // no provenance row: the journal already says it is his
    updates.push({ trackId: t.id, field: 'genre', newValue: r.to })
    result.restored++
  }
  if (result.restored) log(`put back ${result.restored} song(s) to the genre he chose in Get Info: ${[...new Set(table.restores.map((r) => `${r.artist} — ${r.album} → ${r.to}`))].join('; ')}`)

  // 4. Corrections.
  const at = now.toISOString()
  let checkChanged = false
  for (const c of table.corrections) {
    if (!GENRE_NAMES.has(c.to)) { result.skipped.push({ artist: c.artist, album: c.album, reason: `${c.to} is not on the list` }); continue }
    const all = byAlbum(c.artist, c.album)
    const songs = all.filter((t) => (t.genre || '').trim() === c.from)
    if (!songs.length) { result.skipped.push({ artist: c.artist, album: c.album, reason: `no song still on ${c.from}` }); continue }
    // An album he set himself (Get Info, phone, a check-list File) is his
    // answer already — not even a suggestion (Yard Act "Rock", 10/22).
    if (all.some((t) => t.genreBy === 'jake' || t.genreBy === 'phone')) { result.skipped.push({ artist: c.artist, album: c.album, reason: `he set it himself (${c.from})` }); continue }
    const his = songs.filter((t) => isHis(t.genreBy) || (!t.genreBy && isSettled(t) && t.genreApproved))
    const ours = songs.filter((t) => !his.includes(t))
    if (ours.length) {
      const how: FilerHow = c.confidence === 'high' ? 'correction' : 'suggestion'
      for (const t of ours) {
        await deps.persist(t, { genre: c.to }, { by: 'filer', how, confidence: c.confidence === 'high' ? 'high' : 'low' })
        updates.push({ trackId: t.id, field: 'genre', newValue: c.to })
      }
      if (c.confidence === 'high') result.applied.push({ artist: c.artist, album: c.album, from: c.from, to: c.to, songs: ours.length })
      else {
        const key = albumKey(c.artist, c.album)
        const i = check.findIndex((e) => e.key === key)
        const entry: CheckEntry = { key, artist: c.artist, album: c.album, ids: ours.map((t) => t.id), tag: c.from, suggested: c.to, why: `audit: ${c.evidence}`.slice(0, 200), at, evidence: EVIDENCE_VERSION, filedAs: c.to }
        if (i >= 0) check[i] = entry; else check.push(entry)
        checkChanged = true
        result.listed.push({ artist: c.artist, album: c.album, from: c.from, to: c.to, songs: ours.length, review: false })
      }
      log(`${c.artist} — ${c.album}: ${c.from} → ${c.to} (${c.confidence === 'high' ? 'corrected' : 'suggestion; on the check list'}; ${ours.length} song${ours.length === 1 ? '' : 's'}): ${c.evidence}`)
    }
    if (his.length) {
      if (c.confidence !== 'high') { result.skipped.push({ artist: c.artist, album: c.album, reason: `his choice (${c.from}); medium-confidence suggestion ${c.to} not listed` }); continue }
      const key = `review:${albumKey(c.artist, c.album)}`
      if (!check.some((e) => e.key === key)) {
        check.push({ key, artist: c.artist, album: c.album, ids: his.map((t) => t.id), tag: c.from, suggested: c.to, why: `audit suggests ${c.to}: ${c.evidence}`.slice(0, 200), at, evidence: EVIDENCE_VERSION, review: true })
        checkChanged = true
      }
      result.listed.push({ artist: c.artist, album: c.album, from: c.from, to: c.to, songs: his.length, review: true })
      log(`${c.artist} — ${c.album}: his ${c.from} kept; ${c.to} suggested on the check list (${his.length} song${his.length === 1 ? '' : 's'})`)
    }
  }
  if (updates.length) deps.applied(updates)
  if (checkChanged) await deps.saveCheck(check)

  // 5. Done — once.
  await writeFile(markerPath, JSON.stringify({ id: table.id, at, backup, seeded: result.seeded, restored: result.restored, applied: result.applied, listed: result.listed, skipped: result.skipped }, null, 2))
  log(`done: ${result.applied.length} album(s) corrected, ${result.listed.length} on the check list, ${result.restored} song(s) put back to his choice, ${result.skipped.length} skipped`)
  return result
}
