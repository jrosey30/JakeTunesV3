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
  { name: 'Michael M. Rosenbaum', slug: 'rosenbaum', role: 'For the Respondents', side: 'respondent', note: 'Jake’s grandfather — “Poppy”' },
  { name: 'Jay Starkman', slug: 'starkman', role: 'For the Petitioner', side: 'petitioner', note: '' },
]

// Profiles verified June 2026 (Oyez/Justia + status check on the living).
const JUSTICES = [
  {
    name: 'William H. Rehnquist', slug: 'rehnquist', title: 'Chief Justice', vote: 'majority', note: '',
    nominatedBy: 'Richard Nixon (R) · elevated to Chief by Ronald Reagan',
    service: '1972–2005 · Chief from 1986', died: 'Sep 3, 2005 (age 80) · in office',
    bio: 'Ran the tightest courtroom in America for 19 years — presided over Bush v. Gore and a presidential impeachment trial.',
  },
  {
    name: 'John Paul Stevens', slug: 'stevens', title: 'Associate Justice', vote: 'dissent', note: '',
    nominatedBy: 'Gerald Ford (R)',
    service: '1975–2010', died: 'Jul 16, 2019 (age 99)',
    bio: 'A Republican appointee who became leader of the Court’s liberal wing; served 35 years, third-longest ever.',
  },
  {
    name: 'Sandra Day O’Connor', slug: 'oconnor', title: 'Associate Justice', vote: 'majority', note: '',
    nominatedBy: 'Ronald Reagan (R)',
    service: '1981–2006', died: 'Dec 1, 2023 (age 93)',
    bio: 'The first woman ever to sit on the Supreme Court — and the decisive swing vote of her era.',
  },
  {
    name: 'Antonin Scalia', slug: 'scalia', title: 'Associate Justice', vote: 'majority', note: '',
    nominatedBy: 'Ronald Reagan (R)',
    service: '1986–2016', died: 'Feb 13, 2016 (age 79) · in office',
    bio: 'Father of modern originalism and the Court’s sharpest pen — the Justice who spars hardest with both lawyers on this tape.',
  },
  {
    name: 'Anthony M. Kennedy', slug: 'kennedy', title: 'Associate Justice', vote: 'majority', note: '',
    nominatedBy: 'Ronald Reagan (R)',
    service: '1988–2018',
    bio: 'For three decades the Court’s swing vote — the man both sides aimed every argument at.',
  },
  {
    name: 'David H. Souter', slug: 'souter', title: 'Associate Justice', vote: 'dissent', note: '',
    nominatedBy: 'George H. W. Bush (R)',
    service: '1990–2009', died: 'May 8, 2025 (age 85)',
    bio: 'The famously frugal New Hampshire judge who surprised his appointers by joining the liberal wing.',
  },
  {
    name: 'Clarence Thomas', slug: 'thomas', title: 'Associate Justice', vote: 'majority', note: 'Wrote the opinion — yet never asked a single question',
    nominatedBy: 'George H. W. Bush (R)',
    service: '1991–present · the longest-tenured sitting Justice',
    bio: 'The Court’s most conservative member and its quietest at argument — silent on this tape, then wrote the opinion that won Poppy’s case.',
  },
  {
    name: 'Ruth Bader Ginsburg', slug: 'ginsburg', title: 'Associate Justice', vote: 'majority', note: '',
    nominatedBy: 'Bill Clinton (D)',
    service: '1993–2020', died: 'Sep 18, 2020 (age 87) · in office',
    bio: 'Pioneering women’s-rights litigator turned liberal icon — later beloved as “the Notorious RBG.”',
  },
  {
    name: 'Stephen G. Breyer', slug: 'breyer', title: 'Associate Justice', vote: 'majority', note: '',
    nominatedBy: 'Bill Clinton (D)',
    service: '1994–2022',
    bio: 'The Court’s pragmatist — famous for sprawling hypotheticals that make advocates sweat.',
  },
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

async function advocatesWithPhotos(): Promise<Array<typeof ADVOCATES[number] & { photo: string | null }>> {
  return Promise.all(ADVOCATES.map(async (a) => {
    for (const ext of ['jpg', 'png', 'webp'] as const) {
      try {
        const buf = await readFile(join(vaultDir(), 'advocates', `${a.slug}.${ext}`))
        const mime = ext === 'jpg' ? 'jpeg' : ext
        return { ...a, photo: `data:image/${mime};base64,${buf.toString('base64')}` }
      } catch { /* try the next extension */ }
    }
    return { ...a, photo: null }
  }))
}

const AMICUS_SYSTEM = `You are "Amicus" — a spellbinding guide to a live Supreme Court argument, narrating it for someone on their FIRST DAY of law school. You make the law thrilling: you have the charisma of a great professor who leans in and says "now watch THIS." Bring intrigue, momentum, and the high stakes of the room to life — without ever showing off or condescending.

THE CASE: Beck v. Prupis (529 U.S. 494), a CIVIL RICO case. Michael M. Rosenbaum argues for the RESPONDENTS; he is the listener's grandfather, so treat the moment with respect — but in your answers ALWAYS call him "Mr. Rosenbaum" (never "Poppy") and the opposing advocate "Mr. Starkman." His side WON, 7–2; Justice Thomas wrote the opinion. Mr. Starkman argues for petitioner Robert Beck. The core issue: whether someone can sue under RICO's conspiracy provision for an injury caused by an act that ISN'T itself an act of racketeering (Beck's injury was being fired). The Court said no.

HOW YOU EXPLAIN:
- Assume ZERO legal knowledge. The instant you use a legal term — "predicate act," "overt act," "cause of action," "standing" — define it in a few plain words, like you're teaching a sharp beginner.
- Be vivid and charismatic. Set the scene, name the move a Justice is making ("Justice Scalia just set a trap…"), and build a little suspense about where it's heading.
- Anchor it in the human stakes — a man was fired; can he even get into federal court? — then land the point with clarity and a little flourish.

LENGTH: a tight 3–4 sentences. Every sentence earns its place — charismatic, never bloated, no preamble, no "essentially." Only go longer if the listener explicitly asks.

FORMAT (critical): your words are READ ALOUD by a text-to-speech voice. Write plain spoken prose ONLY. Never use asterisks, markdown, bullet points, headings, or any emphasis symbols — they get vocalized as garbled noise. Convey emphasis through word choice and rhythm, not punctuation.`

export function registerScotusArchive(deps: ScotusDeps): void {
  ipcMain.handle('scotus:get-archive', async () => {
    try {
      // Audio presence is the gate — without the recording there's no exhibit.
      await readFile(join(vaultDir(), 'argument.mp3')).then(() => {}, () => { throw new Error('no audio') }).catch(() => { throw new Error('no audio') })
      const [segments, justices, advocates] = await Promise.all([loadSegments(), justicesWithPortraits(), advocatesWithPhotos()])
      return { ok: true, exists: true, case: CASE_META, advocates, justices, segments }
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
      const text = await deps.askClaude('scotus-amicus', AMICUS_SYSTEM, user, 400)
      // The answer is both displayed AND read aloud by TTS. Strip markdown /
      // emphasis symbols — the voice garbles asterisks & backticks into the
      // "gibberish/stroke" artifact. (Belt-and-suspenders with the prompt.)
      const answer = text.replace(/[*`#_]+/g, '').replace(/[ \t]{2,}/g, ' ').trim()
      return { ok: true, answer, speaker: window.length ? window[window.length - 1].speaker : '' }
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
