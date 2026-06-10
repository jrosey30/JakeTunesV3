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
    'When a group conspires to violate the federal racketeering law (RICO), and to pull it off commits an act that harms someone — but that act isn’t itself one of the underlying racketeering crimes — can the victim sue under RICO for that harm? Robert Beck said his firing was that kind of harm. The Court had to decide whether a non-racketeering injury opens the RICO courthouse door.',
  background:
    'Robert A. Beck II was president, CEO, and a director of Southeastern Insurance Group. He alleged that the company’s other senior officers and directors were committing fraud, and that when he discovered it and reported them to regulators, they retaliated by orchestrating a scheme to force him out. Beck sued them under civil RICO, claiming their conspiracy had injured him. Michael Rosenbaum — Jake’s grandfather — represented those officers and directors: the respondents.',
  holding:
    'No. Writing for a 7–2 Court, Justice Thomas held that to recover under RICO’s conspiracy provision, the injury must flow from an actual act of racketeering — not merely from some act taken to advance the conspiracy. Beck’s injury (his firing) wasn’t itself a racketeering act, so he had no RICO claim. The respondents — Rosenbaum’s clients — prevailed.',
  significance:
    'The decision drew a hard line around civil RICO, stopping plaintiffs from turning ordinary business or workplace disputes into federal racketeering suits just by alleging a conspiracy. The Court anchored the rule in centuries-old common-law conspiracy principles — a plaintiff must be hurt by a wrongful (here, racketeering) act, not just any act in furtherance. It remains a foundational civil-RICO precedent, cited constantly today.',
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

Your job: translate the lawyer-speak into plain, vivid English. Explain what a Justice's question is really driving at, what a term means, and — when it's clear — whether Poppy is gaining or losing ground in an exchange. Be precise but human; never condescend, never pad. This is personal to the listener; treat the moment with the respect it deserves, but stay grounded in what the transcript actually says. Keep answers tight (2–5 sentences unless asked for more).`

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
      const text = await deps.askClaude('scotus-amicus', AMICUS_SYSTEM, user, 700)
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
