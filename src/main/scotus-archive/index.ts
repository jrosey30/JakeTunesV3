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

import { app } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { join } from 'path'
import { readFile } from 'fs/promises'

export interface ScotusDeps {
  ipc: IpcRegistrar
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

// ── Hall of Fame — verbatim moments from the tape (times from transcript.json;
// each card click-seeks the audio to its moment) ──
const QUOTES = [
  // ⚠️ JAKE'S CURATION — scene-selection style, BY HIS EXPLICIT REQUEST
  // (2026-06-10): the concession/callback/polices cards use HIS condensed
  // quote text (his "..." are intentional scene cuts, like a trailer). Do
  // NOT "restore" them to full transcript segments — that was tried and
  // rejected. The click-to-play time carries the full moment.
  {
    title: 'Poppy steps up', time: 1805.794,
    note: 'Thirty minutes in, it’s his turn — the family’s favorite ten words.',
    lines: [
      { speaker: 'Chief Justice Rehnquist', text: 'Mr. Rosenbaum, we’ll hear from you.' },
      { speaker: 'Mr. Rosenbaum', text: 'Mr. Chief Justice, if it please the Court:' },
    ],
  },
  {
    title: 'The honest concession to Souter', time: 2330.235,
    note: 'Candor at the lectern. He admits the limits of his own position rather than bluffing — which is exactly what experienced advocates do in front of that Court.',
    lines: [
      { speaker: 'Justice Souter', text: 'How about some, and the some that he proposes to be within the concept of the conspiracy are those without which you can’t effect your conspiracy.' },
      { speaker: 'Mr. Rosenbaum', text: 'I tried to think of examples, prior to coming here today... and I, at least within my own thinking, have been unable to come up with any...' },
    ],
  },
  {
    title: 'The Scalia callback', time: 2581.489,
    note: 'Citing the Justice’s own opinion to his face — a veteran move. “I thought you might remember it”: dry, confident, and it landed. Getting Scalia to reminisce mid-argument is no small thing.',
    lines: [
      { speaker: 'Mr. Rosenbaum', text: 'In an interesting opinion from the D.C. Circuit, Justice Scalia... the Halberstam opinion, there was some interesting language. You were on the panel together with Judge Bork and Judge Wall...' },
      { speaker: 'Justice Scalia', text: 'Cat burglar in suburban Virginia. It was a very prominent case around...' },
      { speaker: 'Mr. Rosenbaum', text: 'I thought you might remember it.' },
    ],
  },
  {
    title: 'Scalia polices the argument', time: 3008.728,
    note: 'He didn’t fold — he reframed and kept making his point under pressure.',
    lines: [
      { speaker: 'Justice Scalia', text: 'That’s not why we took the case. Let’s assume that it was in furtherance of the RICO conspiracy and get on with the argument on that point.' },
      { speaker: 'Mr. Rosenbaum', text: 'I’m arguing, Justice Scalia, that even if it was in furtherance of, he doesn’t have standing...' },
    ],
  },
  {
    title: 'Rapid-fire with O’Connor', time: 3146.948,
    note: 'Clean doctrinal ping-pong — why criminal and civil conspiracy work differently under the very same statute.',
    lines: [
      { speaker: 'Justice O’Connor', text: 'Mr. Rosenbaum, section 1962(d) I gather has been held to give rise to criminal liability as well as a civil cause of action.' },
      { speaker: 'Mr. Rosenbaum', text: 'Absolutely, Justice O’Connor. Absolutely.' },
      { speaker: 'Justice O’Connor', text: 'And could there be a criminal prosecution brought here without proof of any predicate act?' },
      { speaker: 'Mr. Rosenbaum', text: 'Absolutely.' },
      { speaker: 'Mr. Rosenbaum', text: 'That’s correct. All that’s necessary for a criminal prosecution is proof of the unlawful agreement.' },
    ],
  },
  {
    title: 'Sparring with Breyer on policy', time: 3517.063,
    note: 'Breyer hammers the policy question; Mr. Rosenbaum lands the federalism answer — RICO doesn’t swallow state wrongful-discharge law.',
    lines: [
      { speaker: 'Justice Breyer', text: 'I can’t get anywhere beyond the policy.' },
      { speaker: 'Justice Breyer', text: 'It either is like the antitrust laws, or it isn’t.' },
      { speaker: 'Mr. Rosenbaum', text: 'If the law is to protect those who are improperly terminated, there are more than adequate State law remedies to protect that.' },
      { speaker: 'Mr. Rosenbaum', text: 'To incorporate that State common law into the RICO statute would essentially be to federalize what are otherwise State law claims, so that’s my direct answer to your question, Your Honor.' },
    ],
  },
  {
    title: '“The case is submitted.”', time: 3630.226,
    note: 'The last words of the hour. Five months later: 7–2, for his clients.',
    lines: [
      { speaker: 'Chief Justice Rehnquist', text: 'Thank you.' },
      { speaker: 'Mr. Rosenbaum', text: 'Thank you, Your Honor.' },
      { speaker: 'Chief Justice Rehnquist', text: 'Thank you, Mr. Rosenbaum. The case is submitted.' },
    ],
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

// ── The decision itself — vault opinion.json (verbatim slip-opinion text,
// extracted from Cornell LII; see the file's `source` field). Optional: an
// archive without it simply doesn't render the section. ──
interface OpinionDoc {
  label: string; author: string; slug: string; joined: string
  blocks: Array<{ kind: 'opener' | 'head' | 'p' | 'end'; text: string }>
  notes: Array<{ n: number; text: string }>
}
interface OpinionData { source: string; decided: string; lineup: string; majority: OpinionDoc; dissent: OpinionDoc }

async function loadOpinion(): Promise<OpinionData | null> {
  try {
    const raw = await readFile(join(vaultDir(), 'opinion.json'), 'utf-8')
    const parsed = JSON.parse(raw) as OpinionData
    return parsed?.majority?.blocks?.length ? parsed : null
  } catch {
    return null
  }
}

// ── Amicus's whole-argument knowledge (built once, cached) ──
// Pre-upgrade, Amicus saw only the 8 segments before the cursor — he
// couldn't answer "did Scalia give him a hard time overall?" or point
// you anywhere. This index gives him the ENTIRE hour in compressed form:
// every segment's time + speaker + opening words, plus the argument's
// shape (who spoke when, who asked how many questions).
let cachedArgumentIndex: string | null = null

async function argumentIndex(): Promise<string> {
  if (cachedArgumentIndex) return cachedArgumentIndex
  const segments = await loadSegments()
  if (segments.length === 0) return ''

  const counts = new Map<string, number>()
  for (const s of segments) counts.set(s.speaker, (counts.get(s.speaker) || 0) + 1)
  const shape = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([who, n]) => `${who}: ${n} turns`)
    .join(' · ')

  const lines = segments.map((s) =>
    `${fmtTime(s.start)} ${s.speaker.split(' ').pop()}: ${s.text.replace(/\s+/g, ' ').slice(0, 72)}`
  )
  cachedArgumentIndex = [
    `ARGUMENT MAP — every turn of the hour (time, speaker's last name, opening words). Use it to answer whole-argument questions and to cite exact moments:`,
    `Speaking turns — ${shape}`,
    ...lines,
  ].join('\n')
  return cachedArgumentIndex
}

/**
 * Apostrophe-proof name equality. The roster (this file) writes
 * "Sandra Day O’Connor" with a typographic apostrophe; the Oyez
 * transcript writes "Sandra Day O'Connor" with an ASCII one — exact
 * equality silently failed ONLY for her (the one name with an
 * apostrophe), so her portrait never lit while she spoke.
 * ⚠️ TWIN: src/renderer/views/ScotusView/ScotusView.tsx sameName() —
 * same rule on the renderer side (colonnade highlight). Keep in sync.
 */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()
  return norm(a) === norm(b)
}

/** Map speaker → vault portrait slug (Justices only; advocates use initials). */
function portraitSlug(speaker: string): string | null {
  const j = JUSTICES.find((x) => sameName(x.name, speaker))
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

THE CASE: Beck v. Prupis (529 U.S. 494), a CIVIL RICO case. Michael M. Rosenbaum is the listener's grandfather, so treat the moment with respect — but in your answers ALWAYS call him "Mr. Rosenbaum" (never "Poppy") and the opposing advocate "Mr. Starkman." The core issue: whether someone can sue under RICO's conspiracy provision for an injury caused by an act that ISN'T itself an act of racketeering (Beck's injury was being fired). The Court said no, 7–2; Justice Thomas wrote the opinion.

WHO IS WHO — never confuse the parties:
- Mr. Rosenbaum's CLIENTS are the RESPONDENTS: Ronald Prupis and the other former senior officers and directors of Southeastern Insurance Group — the men Beck ACCUSED of fraud and of conspiring to force him out. Mr. Rosenbaum defends the accused. His side WON.
- Mr. Starkman's CLIENT is the PETITIONER: Robert A. Beck II, the fired president and CEO who brought the RICO suit. His side lost.
- Beck is NEVER Mr. Rosenbaum's client. Prupis is NEVER Mr. Starkman's client. If you mention a client, double-check it against this block first.

HOW YOU EXPLAIN:
- Assume ZERO legal knowledge. The instant you use a legal term — "predicate act," "overt act," "cause of action," "standing" — define it in a few plain words, like you're teaching a sharp beginner.
- Be vivid and charismatic. Set the scene, name the move a Justice is making ("Justice Scalia just set a trap…"), and build a little suspense about where it's heading.
- Anchor it in the human stakes — a man was fired; can he even get into federal court? — then land the point with clarity and a little flourish.

YOUR REACH: you receive an ARGUMENT MAP of the entire hour (every turn: time, speaker, opening words) plus the exchange around the listener's cursor. So you can answer questions about the WHOLE argument — how a Justice treated each side overall, where a thread started, what's still coming — not just the current moment. Ground every claim in the map or the excerpt; if neither supports an answer, say you'd rather not guess.

POINTING TO MOMENTS (critical): when your answer references one or two specific moments on the tape, add cue lines at the VERY END of your reply, each on its own line, in EXACTLY this form:
CUE 43:01 Scalia's Halberstam callback
Rules: at most 2 cues; the time must be copied from the ARGUMENT MAP (never invented); the label is 3–6 words. Cue lines are stripped before your prose is read aloud — they become "jump to this moment" buttons for the listener. Never mention the cues in your prose ("see the cue below" is forbidden); the prose must stand alone.

LENGTH: a tight 3–4 sentences. Every sentence earns its place — charismatic, never bloated, no preamble, no "essentially." Only go longer if the listener explicitly asks.

FORMAT (critical): your words are READ ALOUD by a text-to-speech voice. Write plain spoken prose ONLY. Never use asterisks, markdown, bullet points, headings, or any emphasis symbols — they get vocalized as garbled noise. Convey emphasis through word choice and rhythm, not punctuation.`

export function registerScotusArchive(deps: ScotusDeps): void {
  const { ipc } = deps
  ipc.handle('scotus:get-archive', async () => {
    try {
      // Audio presence is the gate — without the recording there's no exhibit.
      await readFile(join(vaultDir(), 'argument.mp3')).then(() => {}, () => { throw new Error('no audio') }).catch(() => { throw new Error('no audio') })
      const [segments, justices, advocates, opinion] = await Promise.all([loadSegments(), justicesWithPortraits(), advocatesWithPhotos(), loadOpinion()])
      return { ok: true, exists: true, case: CASE_META, advocates, justices, segments, quotes: QUOTES, opinion }
    } catch {
      return { ok: true, exists: false }
    }
  }, { public: true })

  ipc.handle('scotus:get-audio', async () => {
    try {
      const buf = await readFile(join(vaultDir(), 'argument.mp3'))
      return { ok: true, bytes: buf }
    } catch {
      return { ok: false, error: 'io-failed' }
    }
  }, { public: true })

  // Amicus — explain the moment at `time`, or answer a free-form question.
  // `history` is the visible chat thread (renderer-truncated), so follow-ups
  // like "what does that mean?" resolve against what Amicus already said.
  ipc.handle('scotus:amicus', async (_e, input: { mode: 'explain' | 'ask'; time?: number; question?: string; history?: Array<{ role: string; text: string }> }) => {
    try {
      const segments = await loadSegments()
      const t = typeof input?.time === 'number' ? input.time : 0
      // The exchange around the cursor: up to ~8 segments ending at `time`.
      const upto = segments.filter((s) => s.start <= t + 1)
      const window = upto.slice(-8)
      const ctx = window.map((s) => `${s.speaker}: ${s.text}`).join('\n')
      const hist = (Array.isArray(input?.history) ? input.history : []).slice(-6)
      const histBlock = hist.length
        ? ['Your conversation with the listener so far:', ...hist.map((h) => `${h.role === 'user' ? 'Listener' : 'Amicus'}: ${h.text}`), ''].join('\n')
        : ''
      const argMap = await argumentIndex()
      const user = input.mode === 'ask'
        ? [
            histBlock,
            `The listener is at ${fmtTime(t)} in the argument. Here's the exchange right before their question:`,
            ctx || '(start of argument)',
            ``,
            `Their question: ${(input.question || '').trim()}`,
          ].filter(Boolean).join('\n')
        : [
            histBlock,
            `Explain, in plain English, what's happening in this exchange at ${fmtTime(t)} — what's being argued and what the Justice is really getting at:`,
            ctx || '(the very start of the argument)',
          ].filter(Boolean).join('\n')
      // The argument map rides in the system prompt so Amicus knows the
      // whole hour, not just the cursor window.
      const system = argMap ? `${AMICUS_SYSTEM}\n\n${argMap}` : AMICUS_SYSTEM
      const text = await deps.askClaude('scotus-amicus', system, user, input.mode === 'ask' ? 550 : 400)
      // Parse + strip trailing CUE lines (they become jump buttons; the
      // prose is what gets displayed AND read aloud).
      const cues: Array<{ time: number; label: string }> = []
      const lines = text.split('\n')
      while (lines.length > 0) {
        const last = lines[lines.length - 1].trim()
        const m = last.match(/^CUE\s+(\d{1,2}):(\d{2})\s+(.{2,60})$/)
        if (!m) break
        lines.pop()
        const secs = parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
        if (secs >= 0 && secs < 4000 && cues.length < 2) cues.unshift({ time: secs, label: m[3].trim() })
      }
      // The answer is both displayed AND read aloud by TTS. Strip markdown /
      // emphasis symbols — the voice garbles asterisks & backticks into the
      // "gibberish/stroke" artifact. (Belt-and-suspenders with the prompt.)
      const answer = lines.join('\n').replace(/[*`#_]+/g, '').replace(/[ \t]{2,}/g, ' ').trim()
      return { ok: true, answer, cues, speaker: window.length ? window[window.length - 1].speaker : '' }
    } catch {
      return { ok: false, error: 'api-failed' }
    }
  }, { refuse: REFUSED_SENDER })
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export { portraitSlug }
