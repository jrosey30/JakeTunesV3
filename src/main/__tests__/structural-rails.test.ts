/**
 * The iron-clad rails — CLAUDE.md's paper rules, promoted to machine gates.
 *
 * Jake, 2026-08-16: "all code rules need to be iron clad to making the app
 * work as designed." Every rule in this file has already been violated at
 * real cost while existing only as prose: the type net was down for weeks
 * behind 73 errors nothing checked; a tested doctrine function sat unwired
 * while an inline twin drifted-in-waiting did its job; a deleted module
 * shipped inside the asar for two months; 78 silent catch-swallows hid a
 * "dead in production" hunt that took an hour to disprove.
 *
 * Two mechanisms:
 *   BANS     — things that must be ZERO, forever.
 *   RATCHETS — debts too big to fix tonight, locked at today's count so
 *              they can only shrink. Lowering a ratchet after cleanup is
 *              the intended maintenance; raising one requires saying so in
 *              this file, in a commit, out loud.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '../..')

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, exts))
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
  }
  return out
}

function countAcross(files: string[], re: RegExp): { total: number; hits: Array<{ file: string; n: number }> } {
  const hits: Array<{ file: string; n: number }> = []
  let total = 0
  for (const f of files) {
    const n = (readFileSync(f, 'utf-8').match(re) || []).length
    if (n > 0) { hits.push({ file: f.slice(SRC.length + 1), n }); total += n }
  }
  return { total, hits }
}

describe('BANS — zero, forever', () => {
  test('no renderer browser dialogs — they fail SILENTLY in Electron', () => {
    // CLAUDE.md: "Zero results is the only acceptable output." Matches CALLS
    // (with the paren), not comments that cite the rule.
    const files = walk(join(SRC, 'renderer'), ['.ts', '.tsx'])
    const { total, hits } = countAcross(files, /window\.(prompt|alert|confirm)\s*\(/g)
    assert.equal(total, 0,
      `forbidden renderer dialog call(s) in: ${hits.map((h) => h.file).join(', ')} — these return null/no-op silently in Electron; use inline inputs / ConfirmDialog`)
  })

  test('no raw ipcMain.handle outside the registrar — default-deny is the doctrine', () => {
    // Every handler goes through createIpcRegistrar so a forgotten sender
    // guard is impossible-by-default. ipcMain.on for fire-and-forget events
    // is allowed; HANDLE (request/response) must use the registrar.
    const files = walk(join(SRC, 'main'), ['.ts']).filter((f) => !f.endsWith('ipc-register.ts'))
    const { total, hits } = countAcross(files, /ipcMain\.handle\(/g)
    assert.equal(total, 0,
      `raw ipcMain.handle in: ${hits.map((h) => `${h.file}(${h.n})`).join(', ')} — register through createIpcRegistrar`)
  })
})

describe('RATCHETS — locked at today, may only shrink', () => {
  // ── index.ts line count ──────────────────────────────────────────────
  // The god file. 17,067 lines on lock day, and every wiring regression
  // this codebase has suffered lived inside it. The decomposition project
  // (persona-memory, library-digest, personas, listener-profile, exa,
  // eviction, …) shrinks it cut by cut; this ratchet makes growth a
  // deliberate act instead of the path of least resistance. Small slack
  // (+150) so an ordinary fix isn't blocked mid-crisis; the direction is
  // what's enforced.
  // 2026-08-25 re-baselined 16255 -> 16437 for the main merge ONLY. index.ts
  // did not sprawl: this branch sat at 16403, UNDER the old lock, and the growth
  // is main's three already-reviewed PRs arriving intact — #41 iTunesDB file
  // sizes (+79), #42 decade gating (+154), #43 BPM octave arbiter (+71). The
  // lock is set so post-merge (16587) sits exactly at limit+150 with ZERO new
  // slack, so the ratchet keeps biting from the new baseline. Raise this for a
  // merge from main; NEVER to make room for new capability — that belongs in a
  // module (personas.ts / library-eviction.ts).
  const INDEX_LINES_LOCKED = 10974
  test(`index.ts stays ≤ ${INDEX_LINES_LOCKED + 150} lines and the lock follows it down`, () => {
    const lines = readFileSync(join(SRC, 'main/index.ts'), 'utf-8').split('\n').length
    assert.ok(lines <= INDEX_LINES_LOCKED + 150,
      `index.ts is ${lines} lines (lock ${INDEX_LINES_LOCKED} + 150 slack). New capability belongs in a MODULE — see the decomposition pattern in personas.ts / library-eviction.ts.`)
    if (lines < INDEX_LINES_LOCKED - 300) {
      assert.fail(`index.ts shrank to ${lines} — good work; lower INDEX_LINES_LOCKED to ${lines} in this file so the gain is locked in.`)
    }
  })

  // ── silent catches ───────────────────────────────────────────────────
  // `.catch(() => {})` swallowed the mixtape-mint "failure" (which was
  // real), the auto-repair abort (which cost a night), and 76 friends.
  // Some are legitimate (fire-and-forget UI notices); the RATE of new ones
  // is the disease. Locked at 78: every new silent catch either handles
  // its error, logs once (the silence-expected-failures doctrine: gate on
  // observable state, log the abnormal), or consciously raises this
  // number in its commit.
  const SILENT_CATCHES_LOCKED = 64
  test(`silent .catch(() => {}) in main stays ≤ ${SILENT_CATCHES_LOCKED}`, () => {
    // Live code only: _archive is dead by definition, and test files cite
    // the pattern as data (this one included — the regex is assembled so
    // it cannot match its own source).
    const files = walk(join(SRC, 'main'), ['.ts'])
      .filter((f) => !f.includes('/_archive/') && !f.includes('/__tests__/'))
    const { total, hits } = countAcross(files, new RegExp('\\.catch' + '\\(\\(\\) => \\{\\}\\)', 'g'))
    assert.ok(total <= SILENT_CATCHES_LOCKED,
      `${total} silent catches (locked at ${SILENT_CATCHES_LOCKED}). New ones in: ${hits.slice(0, 4).map((h) => `${h.file}(${h.n})`).join(', ')} — handle it, log it, or raise the lock in your commit with a reason.`)
    if (total < SILENT_CATCHES_LOCKED - 10) {
      assert.fail(`silent catches down to ${total} — lower SILENT_CATCHES_LOCKED to ${total} to lock in the cleanup.`)
    }
  })
})

describe('WIRING — the tested code is the live code', () => {
  // The class of regression this repo actually suffers: rebuilds that drop
  // wires while every unit test stays green. Each entry pins a doctrine
  // function to its call sites. (Per-feature locks live in their own test
  // files — audio-signal-path, stream-playback-path, download-explicit;
  // this is the roster of load-bearing wires with no better home.)
  const WIRES: Array<{ fn: string; file: string; minCalls: number; why: string; literal?: boolean }> = [
    { fn: 'explicitWins', file: 'main/download-search.ts', minCalls: 1, why: 'the dedupe merge must run on the TESTED doctrine (unwired 08/10-08/15; moved with P1C3)' },
    { fn: 'ensureContiguousDb', file: 'main/sync-engine/index.ts', minCalls: 1, why: 'the catalog layout pass — content gates cannot see fragmentation (moved with the P1C2 sync-engine cut)' },
    { fn: 'sweepOnce', file: 'main/index.ts', minCalls: 1, why: 'pass-through eviction — without the wire the laptop silently hoards again' },
    { fn: 'initPersonaPrompts', file: 'main/index.ts', minCalls: 1, why: 'supplier injection — a missing init freezes activeHost at boot value' },
    { fn: 'searchItunesSuggestions', file: 'main/ipc/album-info-ipc.ts', minCalls: 1, why: 'P1C3 — the search shim must call the module (moved with the album-info cut)' },
    { fn: 'startAlbumPersonnelPrefetch', file: 'main/ipc/album-info-ipc.ts', minCalls: 1, why: 'album credits "already there" (2026-10-30) — unwired, every album page loads its personnel from MusicBrainz again' },
    { fn: 'itunesAlbumTracks', file: 'main/ipc/album-info-ipc.ts', minCalls: 1, why: 'P1C3 — the album-expand shim must call the module (moved with the album-info cut)' },
    { fn: 'initImportPipeline', file: 'main/index.ts', minCalls: 1, why: 'P1C1 — the pipeline is dead weight without its world wired in' },
    { fn: 'initRagRetrieval', file: 'main/index.ts', minCalls: 1, why: 'P1 rag cut — retrieval throws on first call if its world is never wired in' },
    { fn: 'ingestIpodRoundTrip', file: 'main/index.ts', minCalls: 1, why: 'the 6.0 story — unwired, every offline listen evaporates again' },
    // Called as df.applyQualityFloor (dynamic-import namespace), so the wire
    // matches the literal dotted form the bare-call regex would reject.
    { fn: '.applyQualityFloor(', file: 'main/index.ts', minCalls: 1, literal: true, why: 'discovery quality floor — without the wire the shop ships 40% "no signal" cards again' },
    { fn: 'startTaxonomyStagedApply', file: 'main/index.ts', minCalls: 1, why: 'subgenre hand-off — unwired, the nightly classifier defers forever while the app is open (Sep 6 → Oct 19, 1,220 songs)' },
    { fn: 'startTasteStatePull', file: 'main/index.ts', minCalls: 1, why: 'learned taste — unwired, the strip never sees what the nightly taste engine learned' },
    { fn: 'initArtistDiscography', file: 'main/index.ts', minCalls: 1, why: 'release gate (2026-10-20) — unwired, every artist page throws instead of listing releases' },
    { fn: 'gateReleaseGroups', file: 'main/artist-discography.ts', minCalls: 1, why: 'release gate — unwired, bootlegs, namesakes and unavailable releases reach the artist page again' },
    { fn: 'initFlightRecorder', file: 'main/index.ts', minCalls: 1, why: 'reliability P0 — without the recorder the app goes back to being blind to its own failures' },
    { fn: 'decideSyncMode', file: 'main/sync-orchestrator.ts', minCalls: 1, why: 'WAN full-sync doctrine — unwired, every remote safety-net run burns the 10-min kill-timer again' },
    { fn: 'onNasRecovery', file: 'main/sync-orchestrator.ts', minCalls: 1, why: 'recovery kick — unwired, good windows on a flapping link go back to being harvested by luck' },
    // 2026-11-09: the crates file by Jake's own rules, genre first (genreForPick replaced binForGenre here).
    { fn: 'genreForPick', file: 'main/discover-feed.ts', minCalls: 1, why: 'shop crates — unwired, the daily picks reach the page with no genre and every card lands in one crate again' },
    { fn: 'pickHookIndex', file: 'main/discover-feed.ts', minCalls: 1, why: 'album hook sample — unwired, album cards lose their 30s sell' },
    { fn: 'albumAdjacent', file: 'renderer/hooks/useAudio.ts', minCalls: 2, why: 'Album Mode — unwired, merged-work seams (The Wall, Discovery) fall back to gapped or crossfaded transitions' },
    { fn: 'getEqInputNode', file: 'renderer/audio/seamScheduler.ts', minCalls: 1, why: 'Album Mode — unwired, seam buffers bypass the EQ/width chain and every seam carries a character jump' },
    { fn: '.stampBins(', file: 'main/index.ts', minCalls: 2, literal: true, why: 'crate reorg — the feed gen AND every served feed must file cards into crates' },
    { fn: '.applyScenePitches(', file: 'main/index.ts', minCalls: 1, literal: true, why: 'deeper-than-label-mates doctrine — unwired, the shallow connection lines return' },
    { fn: '.applyAlbumHooks(', file: 'main/index.ts', minCalls: 1, literal: true, why: 'album hook sample — unwired, album cards lose their 30s sell' },
    // spec-01: Play and Export are the same tape. One ruler in common/tape-physics.ts;
    // the player, the deck and the export each call it instead of measuring sides.
    { fn: 'talkoversDue', file: 'renderer/components/TapeMonitor.tsx', minCalls: 1, why: 'spec-01 — unwired, Play Tape goes back to skipping every voice on a one-sided tape' },
    { fn: 'tapeElapsedMs', file: 'renderer/components/DeckBar.tsx', minCalls: 1, why: 'spec-01 — the deck must pin voices with the ruler Play Tape reads them back with' },
    { fn: 'talkoverPlays', file: 'renderer/components/DeckBar.tsx', minCalls: 1, why: 'spec-01 — the strip never says a voice landed that Play Tape would skip' },
    { fn: 'dubTalkovers', file: 'renderer/views/MixtapeView.tsx', minCalls: 1, why: 'spec-01 — Export places every voice where Play Tape fires it' },
    { fn: 'claimTransportKeys', file: 'renderer/views/ScotusView/ScotusView.tsx', minCalls: 1, why: 'spec-02 — unwired, Space in the courtroom toggles the music and the argument at once again' },
    // spec-03: every destroy asks, in the one red dialog.
    { fn: 'enterPresses', file: 'renderer/components/ConfirmDialog.tsx', minCalls: 1, why: 'spec-03 — unwired, Enter on a focused Cancel deletes again' },
    { fn: '<RemoveConcertDialog', file: 'renderer/views/ConcertDetailView.tsx', minCalls: 1, literal: true, why: 'spec-03 — the concert page goes back to a click-twice remove that forgets itself' },
    { fn: '<RemoveConcertDialog', file: 'renderer/views/AlbumDetailView.tsx', minCalls: 1, literal: true, why: 'spec-03 — the album page and the concert page must ask in the same words' },
    { fn: 'setConfirmTapeOver(true)', file: 'renderer/components/MixtapeSheet.tsx', minCalls: 1, literal: true, why: 'spec-03 — taping over a saved tape goes back to destroying it without asking' },
    // 2026-10-10 model upgrade: the 5.x models refuse temperature and think by default.
    { fn: 'withModelPolicy', file: 'main/index.ts', minCalls: 3, why: 'model upgrade — unwired, a 5.x call 400s on temperature or spends its budget thinking and returns no text' },
    { fn: 'armGlobalNets', file: 'renderer/main.tsx', minCalls: 1, why: 'reliability P0 — the renderer crash net must arm before first render or grey screens go unrecorded again' },
    { fn: 'claimTransportKeys', file: 'renderer/views/ListenToTheListView.tsx', minCalls: 1, why: 'unwired, Space in the Listen List previews AND toggles the music, and ↑/↓ nudge the volume while you triage' },
    { fn: 'userEdits.applyPhoneUnstars(', file: 'main/index.ts', minCalls: 1, literal: true,
      why: 'unstar everywhere (2026-10-22) — unwired, an un-star from the phone or another Mac never lowers the rating this Mac holds, and the boot pass re-stars the song' },
    // Passed by REFERENCE (importDownloaded: importDownloadedFiles), never
    // called directly in index — so this wire matches the reference form.
    { fn: 'importDownloaded: importDownloadedFiles', file: 'main/index.ts', minCalls: 2, literal: true,
      why: 'P1C1 — both store integrations receive the import bridge' },
    // iPod songs stay on this Mac (2026-11-08, ipod-keep-local.ts): both eviction routes ask the gate.
    { fn: 'keepLocal: () => ipodLocal.sweepKeep()', file: 'main/index.ts', minCalls: 1, literal: true,
      why: 'unwired, the hourly sweep trashes songs an iPod needs and the next sync fetches them mid-sync again' },
    { fn: 'keepsColon(ipodGate, it.ipodPath)', file: 'main/index.ts', minCalls: 1, literal: true,
      why: 'unwired, stream-convert turns an iPod song into a link to homemini and the next sync fetches it mid-sync again' },
    { fn: 'startIpodLocal', file: 'main/index.ts', minCalls: 1, why: 'unwired, iPod songs are never brought back and the Device page can’t say what’s ready' },
    // "transistor by 311 wont play. it never ends!!" (2026-11-10): what Jake just got stays, and an ALAC file is dropped only once homemini's playable copy is ready.
    { fn: 'confirmPlayableOnHomemini', file: 'main/index.ts', minCalls: 1, why: 'unwired, an ALAC file is dropped before homemini has a copy this Mac can play, and the first tap waits on a download or a conversion' },
    { fn: '|| recent.has(it.ipodPath) || cameBack.has(it.ipodPath) || playerTouches.has(it.ipodPath, now)', file: 'main/index.ts', minCalls: 1, literal: true,
      why: 'unwired, an album is offloaded five minutes after Jake imports it' },
    { fn: 'returnRecentToDisk', file: 'main/index.ts', minCalls: 1, why: 'unwired, the songs Jake just got that were offloaded on 2026-11-09/10 stay as links and each first play waits on homemini' },
    { fn: 'warmKeeper.pass(', file: 'main/index.ts', minCalls: 1, literal: true, why: 'unwired, homemini lets a played song’s copy go and the next tap is the first ask again' },
    { fn: 'streamedAlac.serve(', file: 'main/index.ts', minCalls: 2, literal: true,
      why: 'unwired, a streamed ALAC song downloads whole before its first byte even when homemini has a ready copy' },
  ]
  for (const w of WIRES) {
    test(`${w.fn} is wired (${w.why})`, () => {
      const src = readFileSync(join(SRC, w.file), 'utf-8')
      const calls = w.literal
        ? src.split(w.fn).length - 1
        : (src.match(new RegExp(`(?<![\\w.])${w.fn}\\(`, 'g')) || []).length
      assert.ok(calls >= w.minCalls,
        `${w.fn} has ${calls} call site(s) in ${w.file}, needs ≥${w.minCalls} — a rebuild dropped the wire again`)
    })
  }
})

describe('FORTIFICATIONS — 2026-08-29 ("IT SPEAKS. fortify fortify fortify.")', () => {
  // ── Voice playback: data-URIs are BANNED on media elements ──────────
  // Chromium rejects large data:audio URLs ("Media load rejected by URL
  // safety check"); short quips squeaked under the cap for months and a
  // full Music Man take killed EVERY voice in the app behind a misleading
  // "couldn't reach the mic" notice. Seven sites shared the landmine.
  // Base64 speech goes through audioFromBase64Mpeg (Blob URL) — always.
  test('BAN: no data:audio URIs anywhere in the renderer', () => {
    const files = walk(join(SRC, 'renderer'), ['.ts', '.tsx'])
    const { total, hits } = countAcross(files, /data:audio\/[a-z0-9]+;base64/g)
    assert.equal(total, 0,
      `data:audio URI(s) in: ${hits.map((h) => `${h.file}(${h.n})`).join(', ')} — use audioFromBase64Mpeg (renderer/audio/base64-audio.ts); Chromium refuses large media data-URLs`)
  })

  test('WIRING: audioFromBase64Mpeg carries the voices (≥5 live call sites)', () => {
    const files = walk(join(SRC, 'renderer'), ['.ts', '.tsx']).filter((f) => !f.includes('base64-audio'))
    const { total } = countAcross(files, /audioFromBase64Mpeg\(/g)
    assert.ok(total >= 5,
      `audioFromBase64Mpeg has ${total} call site(s); the DJ/one-shot/Radio/MusicMan/commentary voices all route through it — a drop below 5 means a voice path regressed`)
  })

  // ── Stream spool: the deeper-buffering doctrine stays wired ──────────
  test('WIRING: art thumbs are served only when newer than their art (never on mere presence)', () => {
    const idx = readFileSync(join(SRC, 'main/index.ts'), 'utf-8')
    const serve = readFileSync(join(SRC, 'main/album-art-serve.ts'), 'utf-8')
    // workmini 2026-10-19: Jul 10 thumbs outlived the Sep 2 concert posters.
    // The handler + pregeneration moved to album-art-serve.ts the same day.
    assert.ok(/protocol\.handle\('album-art', createAlbumArtServer\(/.test(idx),
      'album-art:// is no longer served by album-art-serve.ts — the freshness rule below may be bypassed')
    assert.ok(/data = await readFreshThumb\(thumbPath, fullPath\)/.test(serve),
      'the album-art:// protocol reads a cached thumb without checking it is newer than its art — replaced posters show stale')
    assert.ok(/thumbsToBuild\(artDir, thumbDir,/.test(serve) && /pregenerateThumbs\(\{/.test(idx),
      'thumb pregeneration skips by presence again (or is no longer started) — copied-in art keeps stale thumbs')
  })

  test('WIRING: spoolAwareServe is live in the homemini fetch path', () => {
    const idx = readFileSync(join(SRC, 'main/index.ts'), 'utf-8')
    assert.ok(/spoolAwareServe\(/.test(idx),
      'fetchAudioFromHomemini no longer consults the stream spool — WAN jitter reaches playing songs again ("do the deeper buffering thing")')
  })

  test('WIRING: the live proxy is NOT receive-paced — the playing song reads at wire speed', () => {
    const idx = readFileSync(join(SRC, 'main/index.ts'), 'utf-8')
    // workmini 2026-10-19 (Jake's call, on this measurement): #180 read the
    // live-proxy body at 96 KB/s, and undici dropped the half-read socket
    // after ~30 s (UND_ERR_SOCKET) — the 2.9 MB aa82bc48… failed 2 of 3 times
    // paced, 0 of 3 at full speed; stalls + spool failures went 14/h → 35–45/h.
    // The guard wraps homemini's body directly, with nothing in between.
    assert.ok(/withBodyInactivityTimeout\(\s*res\.body as unknown as ReadableStream<Uint8Array>,/.test(idx),
      'the live proxy body no longer goes straight into the inactivity guard — something sits between them again')
    const fn = idx.split('async function fetchAudioFromHomemini(')[1]?.split('\nfunction wantsHomeminiFlac')[0] ?? ''
    assert.ok(fn.length > 0, 'fetchAudioFromHomemini moved — re-point this lock')
    assert.ok(!/pacedBody|pipeThrough\(/.test(fn),
      'fetchAudioFromHomemini paces or transforms the live body again — a slowly read socket gets dropped and songs skip')
  })

  test('BAN: no receive-side pacing — background downloads pace BETWEEN Range requests', () => {
    // The mechanism that failed: a TransformStream that sleeps inside a fetch
    // body. Its name is banned from main, and the three background full-file
    // downloads must go through range-chunk-download.ts instead.
    const files = walk(join(SRC, 'main'), ['.ts']).filter((f) => !f.includes('/__tests__/') && !f.includes('/_archive/'))
    const { total, hits } = countAcross(files, new RegExp('\\bpaced' + 'Body\\(', 'g'))
    assert.equal(total, 0, `receive-side pacing is back in: ${hits.map((h) => `${h.file}(${h.n})`).join(', ')} — pace between Range requests (range-chunk-download.ts)`)
    const spool = readFileSync(join(SRC, 'main/stream-spool.ts'), 'utf-8')
    const mirror = readFileSync(join(SRC, 'main/replica-artwork-mirror.ts'), 'utf-8')
    assert.ok(/await downloadInRangeChunks\(url, part,/.test(spool),
      'landSpool (playback spool + overnight pre-load) no longer downloads through the range-chunk primitive')
    assert.ok(/await fetchInRangeChunks\(`\$\{origin\}\/artwork\/\$\{bare\}`/.test(mirror),
      'the artwork mirror no longer downloads through the range-chunk primitive')
  })

  // ── Downloads: the SoundCloud truncation guard stays in the picker ───
  test('WIRING: pickBestSoundcloudMatch keeps the truncated-paren refusal', () => {
    const m = readFileSync(join(SRC, 'main/streamrip-match.ts'), 'utf-8')
    assert.ok(m.includes('TRUNCATION SUSPICION'),
      'the truncated-desc refusal left pickBestSoundcloudMatch — SoundCloud descs cut at ~50 chars hid "(TopKnot 5 Years L[ater Remix)" and a 5:57 remix imported as a 3:07 song')
  })

  test('WIRING: the SoundCloud lane stages and probes before import', () => {
    const store = readFileSync(join(SRC, 'main/streamrip-store/index.ts'), 'utf-8')
    const scBlock = store.split('── SoundCloud fallback (2026-07-22')[1]?.split('if (!qsearch.ok')[0] ?? ''
    assert.ok(/stageRip\(/.test(scBlock) && /probeStagedFile\(/.test(scBlock),
      'the SoundCloud lane imports without staging witnesses again — "the file\'s own clock is the only trustworthy witness"')
  })

  // ── A clean row: what says it is clean reaches the judge on every door ──
  test('WIRING: a clean row reaches the judge knowing it is clean, and the search drops a rescued row\'s length', () => {
    const store = readFileSync(join(SRC, 'main/streamrip-store/index.ts'), 'utf-8')
    assert.ok(store.includes('cleanedSource: opts?.cleanedSource'), 'the track judge no longer hears the row is clean: the explicit file is held to the censored edit\'s length again')
    assert.ok(!/durationTolSec/.test(store), 'the store chose a tolerance again; exact-recording.ts requestedLength reads it off the row')
    const view = readFileSync(join(SRC, 'renderer/views/DownloadStore/DownloadView.tsx'), 'utf-8')
    const asSongRow = view.split('const asSongRow')[1]?.split('})')[0] ?? ''
    assert.ok(asSongRow.includes('explicitness: t.explicitness'), 'a Get on an expanded album\'s track forgot the row is clean: ±5 s of the censored edit')
    for (const file of ['main/streamrip-store/index.ts', 'main/record-shop-resolve.ts', 'main/ipc/near-edition-ipc.ts']) {
      const src = readFileSync(join(SRC, file), 'utf-8')
      assert.ok(src.includes('explicitness: t.explicitness'), `${file} dropped the track's flag: buildRequestedAlbum keeps the clean length`)
    }
    const search = readFileSync(join(SRC, 'main/download-search.ts'), 'utf-8')
    assert.equal((search.match(/durationSecs: rowSeconds\(/g) ?? []).length, 2, 'a search path carries a rescued row\'s clean length under an explicit label again')
  })

  test('WIRING: every Qobuz file the walk can import is judged with Qobuz\'s explicit flag', () => {
    const store = readFileSync(join(SRC, 'main/streamrip-store/index.ts'), 'utf-8')
    const door = store.split('── The ALBUM DOOR')[1]?.split('── Bandcamp — equal citizen')[0] ?? ''
    assert.ok(door.includes('parentalWarning: t.parentalWarning'), 'the album door picks a track without the flag: Bad and Boujee\'s no-warning edition came in this way (2026-11-04)')
    assert.ok(door.includes('judgeHitsByMeta(req, doorHits, trackMeta, new Set(), explicitOnQobuz)'), 'the album door reads the flag by another rule than the top hits: a track with nothing to censor is refused there again')
    assert.ok(store.includes("parentalWarning: typeof t.parental_warning === 'boolean' ? t.parental_warning : undefined"), 'the album listing lost each track\'s own flag: A Bay Bay\'s album says explicit, its Single Version clean')
    assert.ok(store.includes("const top = mediaType === 'album' ? ranked.slice(0, 6) : ranked"), 'a hit of a song reaches a fetch with nothing asked about it: a row with no length has only this flag')
    assert.ok(store.includes('parentalWarning: flagToJudge(meta, explicitOnQobuz)'), 'a staged file is judged by the raw flag: no warning is not censored')
  })

  // ── Listen List → library: the share source reaches every import door ──
  test('WIRING: every streamrip import carries the job\'s addedVia', () => {
    const store = readFileSync(join(SRC, 'main/streamrip-store/index.ts'), 'utf-8')
    const doors = store.match(/importStaged\((?!staged: StagedRip)[^)]*\)/g) ?? []
    assert.ok(doors.length >= 7, `expected the ladder's import doors, found ${doors.length}`)
    for (const door of doors) {
      assert.ok(door.includes('addedVia'), `${door} drops the Listen List row's share source — a TikTok share downloaded here never reaches the TikTok playlist (2026-11-03)`)
    }
    assert.ok(store.includes("deps.importDownloaded(opts.only ?? staged.files, 'streamrip', opts.addedVia, opts.rowTags)"),
      'importStaged stopped handing addedVia to the importer')
    assert.ok(store.includes("runDownload(['id', source, mediaType, id], shareSourceKey(addedVia))"),
      'the picked-id door dropped the share source')
    const preload = readFileSync(join(SRC, 'preload/index.ts'), 'utf-8')
    assert.ok(preload.includes("ipcRenderer.invoke('streamrip:download-id', source, mediaType, id, addedVia)"),
      'the preload bridge dropped the share source on the picked-id door')
    const panel = readFileSync(join(SRC, 'renderer/components/DownloadsPanel.tsx'), 'utf-8')
    assert.ok(panel.includes('addedVia: q?.result.origin?.addedVia'),
      'songs rescued from a refused album lost the share source')
  })

  // ── Cache warm: not home = no warm ───────────────────────────────────
  test('WIRING: cache-manager.py keeps the home-LAN gate', () => {
    const cm = readFileSync(join(SRC, '../Dr. Claude/scripts/cache-manager.py'), 'utf-8')
    assert.ok(cm.includes('homemini.local'),
      'the cache warm lost its remote-mode gate — at the office it grinds the WAN and starves the streaming it exists to serve')
  })
})
