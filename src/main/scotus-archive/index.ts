// ════════════════════════════════════════════════════════════════════════
//  SCOTUS Archive — Beck v. Prupis (a one-of-one exhibit, not a song)
//
//  Jake's grandfather, Michael M. Rosenbaum ("Poppy"), argued Beck v. Prupis
//  before the U.S. Supreme Court on November 3, 1999 — for the respondents —
//  and won, 7–2. This module gives the official recording a permanent home
//  INSIDE JakeTunes, deliberately OUTSIDE the music library: it is never a
//  Track, never counts a play, never syncs to the phone. Its own private vault.
//
//  Vault: userData/scotus-archive/beck-v-prupis/
//    argument.mp3       — the recording (≈60 min)
//    transcript.json    — { segments: [{ start, stop, speaker, role, text }] }
//    portraits/<slug>.png — the nine Justices
//
//  IPCs:
//    scotus:get-archive  — case facts + roster (portraits inlined) + transcript
//    scotus:get-audio    — the MP3 bytes (renderer makes a blob URL; ~15 MB)
//    scotus:amicus       — the legal guide (plain-English explain / ask)
// ════════════════════════════════════════════════════════════════════════

import { ipcMain, app } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'

export interface ScotusDeps {
  /** Bound in index.ts to claudeCall; string in → answer text out, so this
   *  module stays free of the Anthropic SDK types. */
  askClaude: (callKey: string, system: string, userText: string, maxTokens: number) => Promise<string>
}

function vaultDir(): string {
  return join(app.getPath('userData'), 'scotus-archive', 'beck-v-prupis')
}

// ── Verified case record (Oyez / Justia / Cornell LII — see the hub footer) ──
const CASE_META = {
  name: 'Beck v. Prupis',
  citation: '529 U.S. 494 (2000)',
  docket: 'No. 98-1480',
  argued: 'November 3, 1999',
  decided: 'April 26, 2000',
  court: 'The Rehnquist Court',
  poppy: 'Michael M. Rosenbaum',
  vote: '7–2 for the respondents',
  opinionBy: 'Justice Clarence Thomas',
  question:
    'Beck’s firing wasn’t itself a racketeering crime — yet he called it an injury from a RICO conspiracy. The question: can you sue under RICO when the act that hurt you is just an act furthering the conspiracy, not one of the racketeering crimes?',
  background:
    'Robert Beck, president and CEO of Southeastern Insurance Group, said he caught the other officers committing fraud, reported them to regulators, and was fired in retaliation. He sued them under civil RICO. Poppy — Michael Rosenbaum — represented those officers: the respondents.',
  holding:
    'No — 7–2. Justice Thomas held the injury must come from an actual racketeering act, not just any act advancing the conspiracy. Beck’s firing didn’t qualify, so he had no RICO claim. Poppy’s clients won.',
  significance:
    'It walled off civil RICO: you can’t turn an ordinary business or firing dispute into a federal racketeering suit just by alleging a conspiracy. Rooted in old common-law conspiracy rules, it’s cited constantly to this day.',
}

const ADVOCATES = [
  { name: 'Michael M. Rosenbaum', role: 'For the Respondents', side: 'respondent', note: 'Jake’s grandfather — “Poppy”' },
  { name: 'Jay Starkman', role: 'For the Petitioner', side: 'petitioner', note: '' },
]

const JUSTICES = [
  { name: 'William H. Rehnquist', slug: 'rehnquist', title: 'Chief Justice', vote: 'majority', note: '' },
  { name: 'John Paul Stevens', slug: 'stevens', title: 'Associate Justice', vote: 'dissent', note: '' },
  { name: 'Sandra Day O’Connor', slug: 'oconnor', title: 'Associate Justice', vote: 'majority', note: '' },
  { name: 'Antonin Scalia', slug: 'scalia', title: 'Associate Justice', vote: 'majority', note: '' },
  { name: 'Anthony M. Kennedy', slug: 'kennedy', title: 'Associate Justice', vote: 'majority', note: '' },
  { name: 'David H. Souter', slug: 'souter', title: 'Associate Justice', vote: 'dissent', note: '' },
  { name: 'Clarence Thomas', slug: 'thomas', title: 'Associate Justice', vote: 'majority', note: 'Wrote the opinion — yet never asked a single question' },
  { name: 'Ruth Bader Ginsburg', slug: 'ginsburg', title: 'Associate Justice', vote: 'majority', note: '' },
  { name: 'Stephen G. Breyer', slug: 'breyer', title: 'Associate Justice', vote: 'majority', note: '' },
]

interface Segment { start: number; stop: number; speaker: string; role: string; text: string }
let cachedSegments: Segment[] | null = null

async function loadSegments(): Promise<Segment[]> {
  if (cachedSegments) return cachedSegments
  const raw = await readFile(join(vaultDir(), 'transcript.json'), 'utf-8')
  const parsed = JSON.parse(raw) as { segments?: Segment[] }
  cachedSegments = Array.isArray(parsed.segments) ? parsed.segments : []
  return cachedSegments
}

/** Map speaker → vault portrait slug (Justices only; advocates use initials). */
function portraitSlug(speaker: string): string | null {
  const j = JUSTICES.find((x) => x.name === speaker)
  return j ? j.slug : null
}

async function justicesWithPortraits(): Promise<Array<typeof JUSTICES[number] & { portrait: string | null }>> {
  return Promise.all(JUSTICES.map(async (j) => {
    try {
      const buf = await readFile(join(vaultDir(), 'portraits', `${j.slug}.png`))
      return { ...j, portrait: `data:image/png;base64,${buf.toString('base64')}` }
    } catch {
      return { ...j, portrait: null }
    }
  }))
}

const AMICUS_SYSTEM = `You are "Amicus" — a brilliant, warm Supreme Court law clerk acting as a real-time guide for someone WITHOUT a law degree as they listen to a 1999 oral argument.

The case is Beck v. Prupis (529 U.S. 494). It is a CIVIL RICO case. The advocate Michael M. Rosenbaum is arguing for the RESPONDENTS — and he is the listener's late grandfather ("Poppy"). His side WON, 7–2; Justice Thomas wrote the opinion. The opposing advocate is Jay Starkman, for petitioner Robert Beck. The core issue: whether a person can sue under RICO's conspiracy provision for an injury caused by an act that ISN'T itself an act of racketeering (Beck's injury was being fired). The Court said no.

Your job: translate the lawyer-speak into plain, vivid English. Explain what a Justice's question is really driving at, what a term means, and — when it's clear — whether Poppy is gaining or losing ground in an exchange. Be precise but human; never condescend, never pad. This is personal to the listener; treat the moment with the respect it deserves, but stay grounded in what the transcript actually says.

Keep every answer SHORT — 2 or 3 punchy sentences. No preamble, no "essentially"/"basically," no restating the question; lead straight with the point. Only go longer if explicitly asked.`

export function registerScotusArchive(deps: ScotusDeps): void {
  ipcMain.handle('scotus:get-archive', async () => {
    try {
      // Audio presence is the gate — without the recording there's no exhibit.
      await readFile(join(vaultDir(), 'argument.mp3')).then(() => {}, () => { throw new Error('no audio') }).catch(() => { throw new Error('no audio') })
      const [segments, justices] = await Promise.all([loadSegments(), justicesWithPortraits()])
      return { ok: true, exists: true, case: CASE_META, advocates: ADVOCATES, justices, segments }
    } catch {
      return { ok: true, exists: false }
    }
  })

  ipcMain.handle('scotus:get-audio', async () => {
    try {
      const buf = await readFile(join(vaultDir(), 'argument.mp3'))
      return { ok: true, bytes: buf }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Amicus — explain the moment at `time`, or answer a free-form question.
  ipcMain.handle('scotus:amicus', async (_e, input: { mode: 'explain' | 'ask'; time?: number; question?: string }) => {
    try {
      const segments = await loadSegments()
      const t = typeof input?.time === 'number' ? input.time : 0
      // The exchange around the cursor: up to ~8 segments ending at `time`.
      const upto = segments.filter((s) => s.start <= t + 1)
      const window = upto.slice(-8)
      const ctx = window.map((s) => `${s.speaker}: ${s.text}`).join('\n')
      const user = input.mode === 'ask'
        ? [
            `The listener is at ${fmtTime(t)} in the argument. Here's the exchange right before their question:`,
            ctx || '(start of argument)',
            ``,
            `Their question: ${(input.question || '').trim()}`,
          ].join('\n')
        : [
            `Explain, in plain English, what's happening in this exchange at ${fmtTime(t)} — what's being argued and what the Justice is really getting at:`,
            ctx || '(the very start of the argument)',
          ].join('\n')
      const text = await deps.askClaude('scotus-amicus', AMICUS_SYSTEM, user, 320)
      return { ok: true, answer: text, speaker: window.length ? window[window.length - 1].speaker : '' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export { portraitSlug }
