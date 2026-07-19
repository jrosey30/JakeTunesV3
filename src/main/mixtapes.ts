/**
 * Mixtapes — a group of songs becomes a REAL cassette (Jake, 2026-07-18).
 *
 * Full cassette fantasy: pick a tape (C60/C90/C120), Music Man sequences
 * the songs into a Side A and Side B that each FIT the tape, names it,
 * writes J-card liner notes; Jake can record his own spoken intro which
 * gets processed to sound like it was taped onto ferric oxide in 1979.
 *
 * REVIEW-GATE pattern (matches workout-sync-ipc): `build-mixtape` is a
 * PROPOSAL — nothing persists until the renderer explicitly calls
 * `mixtape-save`. Cancelling a build leaves no trace.
 *
 * Store: userData/mixtapes.json (array of Mixtape). Intro audio:
 * userData/mixtape-intros/<stamp>.m4a, played in the renderer through the
 * same ipod-audio:// protocol the library uses.
 */

import { ipcMain, app } from 'electron'
import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import { fitSide } from '../common/tape-physics'

const execP = promisify(execFile)

type ClaudeCall = (callKey: string, params: MessageCreateParamsNonStreaming) => Promise<Message>

export interface MixtapesHost {
  claudeCall: ClaudeCall
  musicManCore: string
}

export interface MixtapeLinerNote { id: number; note: string }

export interface Mixtape {
  id: string
  title: string
  commentary: string
  dedication?: string
  tapeLength: 60 | 90 | 120
  sideA: number[]
  sideB: number[]
  /** Tape ran out mid-song: ms into the LAST song of the side where the
   *  cassette ends. Playback stops the song right there. */
  sideACutMs?: number
  sideBCutMs?: number
  linerNotes: MixtapeLinerNote[]
  introPath?: string
  createdAt: string
  /** J-card ink color the renderer drew the label with (stable per tape). */
  inkColor?: string
}

interface MixtapeInputTrack {
  id: number
  title?: string
  artist?: string
  album?: string
  genre?: string
  bpm?: number | null
  duration?: number // ms
  playCount?: number
  rating?: number
}

const MIXTAPES_FILE = () => join(app.getPath('userData'), 'mixtapes.json')
const INTROS_DIR = () => join(app.getPath('userData'), 'mixtape-intros')
const MAX_INPUT_SONGS = 150
// TRUE tape limits (Jake: "absolutely true time limits... if i run out of
// space, too bad"). The physics live in src/common/tape-physics.ts — the
// SAME function the renderer's mixing deck uses for its live counter.

async function loadMixtapes(): Promise<Mixtape[]> {
  try {
    const raw = await readFile(MIXTAPES_FILE(), 'utf-8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

async function saveMixtapes(all: Mixtape[]): Promise<void> {
  await writeFile(MIXTAPES_FILE(), JSON.stringify(all, null, 2))
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as Record<string, unknown>
  } catch {
    return null
  }
}

export interface TapeSides {
  sideA: number[]
  sideB: number[]
  /** When set, the LAST song of that side gets cut off this many ms in —
   *  the tape ran out. Playback stops the song right there. */
  sideACutMs?: number
  sideBCutMs?: number
}

/**
 * Enforce the physics of the tape regardless of what the model said:
 * only known ids, no dupes across sides, and ABSOLUTELY TRUE side
 * lengths. The song that crosses the end of the side is kept and CUT
 * at the boundary (if at least MIN_CUT_MS of tape remains) — exactly
 * like a real cassette running out mid-chorus. Everything after it on
 * that side falls off.
 */
function enforceTape(
  rawA: unknown,
  rawB: unknown,
  byId: Map<number, MixtapeInputTrack>,
  sideBudgetMs: number,
): TapeSides {
  const seen = new Set<number>()
  const clean = (raw: unknown): number[] => {
    if (!Array.isArray(raw)) return []
    const out: number[] = []
    for (const v of raw) {
      const id = Number(v)
      if (!byId.has(id) || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  }
  const dur = (id: number) => Number(byId.get(id)?.duration) || undefined
  const a = fitSide(clean(rawA), dur, sideBudgetMs)
  const b = fitSide(clean(rawB), dur, sideBudgetMs)
  return { sideA: a.ids, sideB: b.ids, sideACutMs: a.cutMs, sideBCutMs: b.cutMs }
}

/** Deterministic fallback when the model reply is unusable: keep the
 *  given order, fill Side A then Side B — same true-limit physics. */
function fallbackTape(
  tracks: MixtapeInputTrack[],
  sideBudgetMs: number,
): TapeSides {
  return enforceTape(
    tracks.map((t) => t.id),
    // Side B gets whatever Side A's fit() didn't consume — enforceTape's
    // seen-set dedupe makes passing the full list here safe.
    tracks.map((t) => t.id),
    new Map(tracks.map((t) => [Number(t.id), t])),
    sideBudgetMs,
  )
}

async function buildMixtapeProposal(
  host: MixtapesHost,
  tracks: MixtapeInputTrack[],
  tapeLength: 60 | 90 | 120,
  dedication?: string,
  note?: string,
): Promise<{
  ok: true
  title: string
  commentary: string
  sideA: number[]
  sideB: number[]
  sideACutMs?: number
  sideBCutMs?: number
  linerNotes: MixtapeLinerNote[]
  leftovers: number[]
  sideBudgetMs: number
} | { ok: false; error: string }> {
  if (!Array.isArray(tracks) || tracks.length < 2) {
    return { ok: false, error: 'Pick at least 2 songs for a mixtape.' }
  }
  if (tracks.length > MAX_INPUT_SONGS) {
    return { ok: false, error: `That's ${tracks.length} songs — a tape can't hold that. Narrow it down (${MAX_INPUT_SONGS} max).` }
  }
  const byId = new Map(tracks.map((t) => [Number(t.id), t]))
  const sideBudgetMs = (tapeLength / 2) * 60_000

  const list = tracks.map((t) =>
    `${t.id} | ${t.title || '?'} | ${t.artist || '?'} | ${t.album || ''} | ${t.genre || ''} | ${t.bpm || ''} | ${fmtDur(Number(t.duration) || 0)}`
  ).join('\n')

  const user = [
    `Make a REAL cassette mixtape from these songs. This is a C${tapeLength}: two sides, EXACTLY ${tapeLength / 2}:00 each. TRUE tape physics: when a side runs out, it runs out — if the last song runs past the end it gets CUT OFF mid-song, just like 1985. You may use that deliberately (a song swallowed by the leader is its own kind of ending) or land the side clean. No slack, no mercy.`,
    '',
    `Songs (id | title | artist | album | genre | bpm | length):`,
    list,
    '',
    dedication ? `The tape is dedicated: "${dedication}" — let that shape the mood and the title.` : '',
    note ? `Maker's note: ${note}` : '',
    '',
    'Sequence for FLOW like someone who has made a hundred tapes: Side A opens with a grabber and closes on a high; Side B can dig deeper and the last song is the goodbye. Energy and key changes should feel intentional. If not everything fits, leave songs off — the best TAPE wins, not the most songs.',
    'Use ONLY the ids above.',
    '',
    'Return ONLY JSON:',
    '{"title":"the tape\'s name, like it was written on the label","commentary":"2-3 sentences in your voice for the inside of the J-card","sideA":[ids in play order],"sideB":[ids in play order],"linerNotes":[{"id":123,"note":"aside for that song, max 12 words, like a scribble next to the tracklist"}]}',
  ].filter(Boolean).join('\n')

  let title = ''
  let commentary = ''
  let sides: TapeSides | null = null
  let linerNotes: MixtapeLinerNote[] = []
  try {
    const reply = await host.claudeCall('mixtape-build', {
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: host.musicManCore,
      messages: [{ role: 'user', content: user }],
    })
    const block = reply.content[0]
    const text = block && block.type === 'text' ? block.text : ''
    const parsed = extractJson(text)
    if (parsed) {
      title = String(parsed.title || '').trim()
      commentary = String(parsed.commentary || '').trim()
      sides = enforceTape(parsed.sideA, parsed.sideB, byId, sideBudgetMs)
      if (Array.isArray(parsed.linerNotes)) {
        linerNotes = (parsed.linerNotes as Array<Record<string, unknown>>)
          .map((n) => ({ id: Number(n?.id), note: String(n?.note || '').trim() }))
          .filter((n) => byId.has(n.id) && n.note)
      }
    }
  } catch (err) {
    console.warn('[mixtapes] build call failed, using fallback sequencing:', err)
  }

  if (!sides || (sides.sideA.length + sides.sideB.length) < 2) {
    sides = fallbackTape(tracks, sideBudgetMs)
  }
  if (!title) title = `Mixtape · ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`
  if (!commentary) commentary = 'Dubbed with love. Play loud, rewind with a pencil.'

  const onTape = new Set([...sides.sideA, ...sides.sideB])
  const leftovers = tracks.map((t) => Number(t.id)).filter((id) => !onTape.has(id))
  linerNotes = linerNotes.filter((n) => onTape.has(n.id))

  return { ok: true, title, commentary, ...sides, linerNotes, leftovers, sideBudgetMs }
}

/**
 * 1979 cassette voice chain. The mic capture (webm/opus) becomes a mono
 * AAC that sounds like it was spoken onto a well-used cassette: tape
 * bandwidth (150Hz–4.8kHz), soft saturation, wow (slow pitch wobble),
 * compression, and a pink-noise hiss bed. One ffmpeg pass.
 */
async function process1979(rawPath: string, outPath: string): Promise<void> {
  await execP('ffmpeg', [
    '-y',
    '-i', rawPath,
    '-filter_complex',
    '[0:a]aresample=44100,highpass=f=150,lowpass=f=4800,asoftclip=type=tanh,' +
    'vibrato=f=0.55:d=0.12,' +
    'acompressor=threshold=-20dB:ratio=3:attack=8:release=150,volume=1.15[v];' +
    'anoisesrc=colour=pink:amplitude=0.012:sample_rate=44100[n];' +
    '[v][n]amix=inputs=2:duration=first:dropout_transition=0[out]',
    '-map', '[out]',
    '-ac', '1',
    '-c:a', 'aac',
    '-b:a', '96k',
    outPath,
  ], { timeout: 30_000 })
}

export function registerMixtapesIpc(host: MixtapesHost): void {
  ipcMain.handle('mixtapes-list', async () => {
    const mixtapes = await loadMixtapes()
    return { ok: true, mixtapes }
  })

  ipcMain.handle('build-mixtape', async (
    _e,
    tracks: MixtapeInputTrack[],
    tapeLength: 60 | 90 | 120,
    dedication?: string,
    note?: string,
  ) => {
    try {
      const len: 60 | 90 | 120 = tapeLength === 60 || tapeLength === 120 ? tapeLength : 90
      return await buildMixtapeProposal(host, tracks, len, dedication, note)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'mixtape build failed' }
    }
  })

  // Upsert by id. The renderer sends the full record (from a confirmed
  // build proposal, or an edit like attaching an intro).
  ipcMain.handle('mixtape-save', async (_e, tape: Mixtape) => {
    try {
      if (!tape?.id || !Array.isArray(tape.sideA) || !Array.isArray(tape.sideB)) {
        return { ok: false, error: 'Malformed mixtape.' }
      }
      const all = await loadMixtapes()
      const idx = all.findIndex((m) => m.id === tape.id)
      if (idx >= 0) all[idx] = tape
      else all.unshift(tape)
      await saveMixtapes(all)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'save failed' }
    }
  })

  // Delete gates on the stable mixtape id (identity, not text). The
  // renderer confirms with the user first (ConfirmDialog).
  ipcMain.handle('mixtape-delete', async (_e, id: string) => {
    try {
      const all = await loadMixtapes()
      const gone = all.find((m) => m.id === id)
      const next = all.filter((m) => m.id !== id)
      if (next.length === all.length) return { ok: false, error: 'No mixtape with that id.' }
      await saveMixtapes(next)
      if (gone?.introPath) await unlink(gone.introPath).catch(() => {})
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'delete failed' }
    }
  })

  // Raw mic capture in → 1979 cassette voice out. Returns the processed
  // path; the renderer previews it via ipod-audio:// and attaches it to
  // the tape with mixtape-save.
  ipcMain.handle('save-mixtape-intro', async (_e, data: ArrayBuffer | Uint8Array) => {
    const stamp = Date.now()
    const dir = INTROS_DIR()
    const rawPath = join(dir, `raw-${stamp}.webm`)
    try {
      await mkdir(dir, { recursive: true })
      const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
      if (buf.byteLength < 1000) return { ok: false, error: 'Recording too short — try again.' }
      await writeFile(rawPath, buf)
      const outPath = join(dir, `intro-${stamp}.m4a`)
      await process1979(rawPath, outPath)
      return { ok: true, path: outPath }
    } catch (err) {
      console.warn('[mixtapes] intro processing failed:', err)
      return { ok: false, error: err instanceof Error ? err.message : 'intro processing failed' }
    } finally {
      await unlink(rawPath).catch(() => {})
    }
  })
}
