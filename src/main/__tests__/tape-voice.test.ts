/**
 * spec-01 (2026-10-09): Play and Export are the same tape.
 *
 * A voice laid on a tape (the mic, or a DJ break taped off the radio) is
 * pinned by the deck, fired by Play Tape (TapeMonitor) and mixed by Export
 * (MixtapeView → dub-mixtape). All three now measure the tape with one ruler
 * in src/common/tape-physics.ts. Before this, Play Tape looked each voice up
 * by Side A / Side B; one-sided tapes (every tape since 2026-08-08) have
 * empty side lists, so every voice on them was skipped while the export
 * mixed it in.
 *
 * playThrough() below steps the tape the way Play Tape hears it: each song
 * from its start offset, stopped at a cut, ticking about once a second, with
 * one shot per voice. exportSpot() places a voice the way dub-mixtape builds
 * the file: songs trimmed to their start offset and cut, voices delayed from
 * the head of that file's music.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  tapeElapsedMs, tapeRunMs, tapePlayIds, tapeCutMs, talkoverPlays, talkoversDue, dubTalkovers,
  type TapeRunLike, type TalkoverPin,
} from '../../common/tape-physics.ts'

type Pin = TalkoverPin & { path: string }
type Tape = TapeRunLike & { talkovers?: Pin[] }

const TICK_MS = 1000

function durFn(durations: Record<number, number>) {
  return (id: number) => durations[id]
}

/** Where Play Tape fires each voice: the song and the file position. */
function playThrough(tape: Tape, durOf: (id: number) => number | undefined): Array<{ path: string; id: number; positionMs: number }> {
  const fired: Array<{ path: string; id: number; positionMs: number }> = []
  const played = new Set<string>()
  for (const id of tapePlayIds(tape)) {
    const off = tape.startOffsets?.[String(id)] || 0
    const full = durOf(id) || 0
    const cut = tapeCutMs(tape, id)
    const end = cut !== undefined ? off + cut : full
    for (let pos = off; pos <= end; pos += TICK_MS) {
      for (const tk of talkoversDue(tape, tape.talkovers || [], id, pos, durOf)) {
        const key = `${tk.side}|${tk.atMs}|${tk.path}`
        if (played.has(key)) continue
        played.add(key)
        fired.push({ path: tk.path, id, positionMs: pos })
      }
    }
  }
  return fired
}

/** Where the export puts a voice: which song is under it, and how far into
 *  that song's file. Mirrors dub-mixtape's bed (atrim start..start+cut). */
function exportSpot(
  songs: Array<{ id: number; startMs?: number; cutMs?: number }>,
  atMs: number,
  durOf: (id: number) => number | undefined,
): { id: number; positionMs: number } | null {
  let head = 0
  for (const s of songs) {
    const start = s.startMs || 0
    const len = s.cutMs !== undefined ? s.cutMs : (durOf(s.id) || 0) - start
    if (atMs < head + len) return { id: s.id, positionMs: start + (atMs - head) }
    head += len
  }
  return null
}

/** The songs of each export file, built the way MixtapeView builds them. */
function exportFiles(tape: Tape, twoSided: boolean) {
  const song = (id: number) => ({ id, startMs: tape.startOffsets?.[String(id)], cutMs: tapeCutMs(tape, id) })
  return twoSided
    ? { A: (tape.sideA || []).map(song), B: (tape.sideB || []).map(song) }
    : { A: tapePlayIds(tape).map(song), B: [] as ReturnType<typeof song>[] }
}

/** Every voice fires once, where the export puts it (within one tick). */
function assertPlayMatchesExport(tape: Tape, durOf: (id: number) => number | undefined, twoSided: boolean) {
  const fired = playThrough(tape, durOf)
  const voices = dubTalkovers(tape, tape.talkovers || [], durOf, twoSided)
  const files = exportFiles(tape, twoSided)
  const exported = [
    ...voices.A.map((v) => ({ path: v.path, spot: exportSpot(files.A, v.atMs, durOf) })),
    ...voices.B.map((v) => ({ path: v.path, spot: exportSpot(files.B, v.atMs, durOf) })),
  ]
  assert.equal(fired.length, exported.length, `played ${JSON.stringify(fired)} vs exported ${JSON.stringify(exported)}`)
  for (const e of exported) {
    const f = fired.find((x) => x.path === e.path)
    assert.ok(f, `${e.path} is in the export but never plays`)
    assert.ok(e.spot, `${e.path} is exported past the music`)
    assert.equal(f.id, e.spot.id, `${e.path}: played over song ${f.id}, exported over song ${e.spot.id}`)
    assert.ok(f.positionMs >= e.spot.positionMs && f.positionMs - e.spot.positionMs < TICK_MS,
      `${e.path}: played at ${f.positionMs} ms, exported at ${e.spot.positionMs} ms`)
  }
  return fired
}

describe('a voice on a one-sided tape plays where it was laid down', () => {
  const durOf = durFn({ 1: 180_000, 2: 180_000, 3: 180_000 })

  it('fires over the song the deck pinned it to (the reported bug)', () => {
    // The deck pinned the take while song 2 was 20 s in.
    const tape: Tape = { tracks: [1, 2, 3], sideA: [], sideB: [] }
    const atMs = tapeElapsedMs(tape, 2, 20_000, durOf)!
    assert.equal(atMs, 200_000)
    tape.talkovers = [{ side: 'A', atMs, path: 'take.m4a' }]
    const fired = assertPlayMatchesExport(tape, durOf, false)
    assert.deepEqual(fired.map((f) => f.id), [2])
    assert.equal(fired[0].positionMs, 20_000)
  })

  it('a taped DJ break plays the same way, and each voice fires once', () => {
    const tape: Tape = {
      tracks: [1, 2, 3], sideA: [], sideB: [],
      talkovers: [
        { side: 'A', atMs: 5_000, path: 'mic.m4a' },
        { side: 'A', atMs: 370_000, path: 'dj-break.m4a' },
      ],
    }
    const fired = assertPlayMatchesExport(tape, durOf, false)
    assert.deepEqual(fired.map((f) => [f.path, f.id]), [['mic.m4a', 1], ['dj-break.m4a', 3]])
  })

  it('a song picked up mid-way: the voice lands at the same spot in its file', () => {
    const tape: Tape = { tracks: [1, 2, 3], sideA: [], sideB: [], startOffsets: { '2': 60_000 } }
    // Recorded while song 2's file was at 75 s → 15 s into its tape portion.
    const atMs = tapeElapsedMs(tape, 2, 75_000, durOf)!
    assert.equal(atMs, 180_000 + 15_000)
    tape.talkovers = [{ side: 'A', atMs, path: 'mid.m4a' }]
    const fired = assertPlayMatchesExport(tape, durOf, false)
    assert.equal(fired[0].id, 2)
    assert.equal(fired[0].positionMs, 75_000)
  })

  it('wherever the deck pins a voice, Play Tape fires it at that song and second', () => {
    const tape: Tape = { tracks: [1, 2, 3], sideA: [], sideB: [], startOffsets: { '3': 42_500 } }
    for (const [id, pos] of [[1, 0], [1, 179_000], [2, 1], [2, 90_250], [3, 42_500], [3, 150_000]] as const) {
      const atMs = tapeElapsedMs(tape, id, pos, durOf)!
      const fired = playThrough({ ...tape, talkovers: [{ side: 'A', atMs, path: 'p' }] }, durOf)
      assert.equal(fired.length, 1, `pinned at song ${id} ${pos} ms`)
      assert.equal(fired[0].id, id)
      assert.ok(fired[0].positionMs >= pos && fired[0].positionMs - pos < TICK_MS, `fired at ${fired[0].positionMs}, pinned at ${pos}`)
    }
  })

  it('a voice with no song under it does not play, and is not exported', () => {
    const tape: Tape = { tracks: [1], sideA: [], sideB: [], talkovers: [{ side: 'A', atMs: 180_000, path: 'after.m4a' }] }
    assert.equal(tapeRunMs(tape, durOf), 180_000)
    assert.equal(talkoverPlays(tape, tape.talkovers![0], durOf), false)
    assert.deepEqual(playThrough(tape, durOf), [])
    assert.deepEqual(dubTalkovers(tape, tape.talkovers!, durOf, false), { A: [], B: [] })
  })

  it('a blank tape has nowhere for a voice to play', () => {
    const tape: Tape = { tracks: [], sideA: [], sideB: [] }
    assert.equal(talkoverPlays(tape, { side: 'A', atMs: 0 }, durOf), false)
  })
})

describe('grandfathered two-sided tapes', () => {
  // "all my exes live in brooklyn" (2026-08-08), real durations: three songs
  // on Side A, five on Side B, two takes pinned at the flip.
  const brooklyn = { 9991: 48_733, 9992: 124_865, 9993: 161_587, 9994: 166_867, 9995: 144_827, 9996: 167_172, 9997: 137_260, 9998: 167_653 }
  const durOf = durFn(brooklyn)
  const exes = (): Tape => ({
    sideA: [9991, 9992, 9993], sideB: [9994, 9995, 9996, 9997, 9998],
    talkovers: [
      { side: 'A', atMs: 335_185, path: 'intro-1786159451363.m4a' },
      { side: 'A', atMs: 335_185, path: 'intro-1786159465046.m4a' },
    ],
  })

  it('the two takes at the flip play over the first song of Side B', () => {
    const fired = assertPlayMatchesExport(exes(), durOf, true)
    assert.deepEqual(fired.map((f) => [f.id, f.positionMs]), [[9994, 0], [9994, 0]])
  })

  it('the export puts them at the head of Side B, not past the end of Side A', () => {
    const v = dubTalkovers(exes(), exes().talkovers!, durOf, true)
    assert.deepEqual(v.A, [])
    assert.deepEqual(v.B.map((x) => x.atMs), [0, 0])
  })

  it('a Side B pin from the two-sided era counts from the flip', () => {
    const tape: Tape = { ...exes(), talkovers: [{ side: 'B', atMs: 10_000, path: 'b.m4a' }] }
    const fired = assertPlayMatchesExport(tape, durOf, true)
    assert.deepEqual(fired.map((f) => [f.id, f.positionMs]), [[9994, 10_000]])
    assert.deepEqual(dubTalkovers(tape, tape.talkovers!, durOf, true).B.map((x) => x.atMs), [10_000])
  })

  it('a re-saved old tape (one list now) keeps its Side B voice in the export', () => {
    const old = exes()
    const tape: Tape = { ...old, tracks: [...old.sideA!, ...old.sideB!], talkovers: [{ side: 'B', atMs: 10_000, path: 'b.m4a' }] }
    const v = dubTalkovers(tape, tape.talkovers!, durOf, false)
    assert.deepEqual(v.A.map((x) => x.atMs), [335_185 + 10_000])
    assertPlayMatchesExport(tape, durOf, false)
  })

  it('a Side A cut moves the flip: Side B voices still land on Side B', () => {
    const d = durFn({ 1: 120_000, 2: 180_000, 3: 200_000 })
    const tape: Tape = { sideA: [1, 2], sideB: [3], sideACutMs: 30_000, talkovers: [{ side: 'B', atMs: 0, path: 'b0.m4a' }, { side: 'A', atMs: 140_000, path: 'a.m4a' }] }
    assert.equal(tapeRunMs(tape, d), 120_000 + 30_000 + 200_000)
    const fired = assertPlayMatchesExport(tape, d, true)
    assert.deepEqual(fired.map((f) => [f.path, f.id, f.positionMs]), [['a.m4a', 2, 20_000], ['b0.m4a', 3, 0]])
    // A re-saved copy plays the same cut, so the one-file export cuts there too.
    assertPlayMatchesExport({ ...tape, tracks: [1, 2, 3] }, d, false)
  })

  it('a Side B cut is the end of the tape: songs after it are not on the run', () => {
    const d = durFn({ 1: 100_000, 2: 100_000, 3: 100_000 })
    const tape: Tape = { tracks: [1, 2, 3], sideA: [1], sideB: [2], sideBCutMs: 20_000 }
    assert.deepEqual(tapePlayIds(tape), [1, 2])
    assert.equal(tapeRunMs(tape, d), 120_000)
    assert.equal(talkoverPlays(tape, { side: 'A', atMs: 125_000 }, d), false)
  })
})
