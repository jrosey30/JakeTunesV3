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

// ── Hall of Fame — verbatim moments from the tape (times from transcript.json;
// each card click-seeks the audio to its moment) ──
const QUOTES = [
  {
    title: 'Poppy steps up', time: 1805.794,
    note: 'Thirty minutes in, it’s his turn — the family’s favorite ten words.',
    lines: [
      { speaker: 'Chief Justice Rehnquist', text: 'Mr. Rosenbaum, we’ll hear from you.' },
      { speaker: 'Mr. Rosenbaum', text: 'Mr. Chief Justice, if it please the Court:' },
    ],
  },
  {
    title: '“In a way, Your Honor”', time: 1906.029,
    note: 'Justice Kennedy reaches for precedent; Mr. Rosenbaum turns the case to his side in one breath — and draws a “Correct.” from Justice Breyer.',
    lines: [
      { speaker: 'Justice Kennedy', text: 'Sedima did say that, did it not?' },
      { speaker: 'Mr. Rosenbaum', text: 'In a way, Your Honor, but Sedima ultimately stands for the proposition that there must be predicate act-type injury as opposed to the more amorphous concept of racketeering injury.' },
      { speaker: 'Justice Breyer', text: 'Correct.' },
    ],
  },
  {
    title: 'Double-teamed', time: 2147.235,
    note: 'Two Justices fighting over who grills him next — Scalia doesn’t even get to finish his sentence.',
    lines: [
      { speaker: 'Justice Souter', text: 'What’s your answer to that?' },
      { speaker: 'Mr. Rosenbaum', text: 'My answer to that, Your Honor, is that on this record... on this record, and I think my adversary essentially conceded away his argument when stating that if it is a conspiracy which is interfered with as a result of the termination, you should have standing, but if it’s in retaliation for already having blown the whistle... he made that response to one of the questions... then obviously the retaliation is not in furtherance of the conspiracy.' },
      { speaker: 'Justice Scalia', text: 'Okay, but that’s...' },
      { speaker: 'Justice Souter', text: 'That’s your only response to that argument? That in effect is saying, even if he’s right, I will still win, and my question is, why isn’t he right in his claim that to conspire under (d) must be read as broadly as he says?' },
    ],
  },
  {
    title: '“I think I know what your problem is”', time: 2364.437,
    note: 'Scalia’s famous bank-guard heist, aimed straight at him — and Mr. Rosenbaum stands his ground.',
    lines: [
      // 39:24's "Well, take a simple... no, you go." is deliberately NOT
      // printed: Oyez tags it Scalia, but the audio reads as two Justices
      // colliding — attribution uncertain, so it stays off the card. The
      // play-time still starts at 2364.4 so the collision is heard raw.
      { speaker: 'Justice Scalia', text: 'I think I know what your problem is, Mr. Rosenbaum. It’s the statement you made earlier that these nonpredicate acts have nothing to do with the goal of the conspiracy, which is to commit the predicate acts. That’s simply not true.' },
      { speaker: 'Justice Scalia', text: 'Some of the means along the end to that goal, killing the bank guard, happen to be unlawful acts covered by RICO, and therefore they become predicate acts, not because they are the goal of the conspiracy... they didn’t intend to kill... the object wasn’t to kill the guard. It was to get the money in the bank.' },
      { speaker: 'Mr. Rosenbaum', text: 'That may be so, Justice Scalia, but the answer to the question that I think is being posed to me is whether or not that goal, albeit essential to the completion of the conspiracy, still provides a basis for RICO standing.' },
    ],
  },
  {
    title: 'Getting a word in', time: 2502.809,
    note: 'Answering Justice Scalia is its own sport. Final score: Scalia 4 sentences, Mr. Rosenbaum 5 words.',
    lines: [
      { speaker: 'Justice Scalia', text: 'I don’t see how you get there through the text, is my problem.' },
      { speaker: 'Mr. Rosenbaum', text: 'I’m sorry, Justice...' },
      { speaker: 'Justice Scalia', text: 'I don’t see how you get there through the text. I mean, it may be a very nice disposition, but how do you get there through the text of 1964 and 1962?' },
      { speaker: 'Mr. Rosenbaum', text: 'I get...' },
      { speaker: 'Justice Scalia', text: '1964 makes a violation of (a), (b), (c), and (d) unlawful.' },
    ],
  },
  {
    title: '“Because?”', time: 3519.073,
    note: 'Justice Breyer wants the policy answer and won’t settle for less — and Mr. Rosenbaum finally lands it.',
    lines: [
      { speaker: 'Justice Breyer', text: 'It either is like the antitrust laws, or it isn’t.' },
      { speaker: 'Mr. Rosenbaum', text: 'It certainly is like the anti...' },
      { speaker: 'Justice Breyer', text: 'Because?' },
      { speaker: 'Mr. Rosenbaum', text: 'It certainly is like the antitrust laws, because section 4 of the Clayton Act, the language is...' },
      { speaker: 'Justice Breyer', text: 'No, the language is identical.' },
      { speaker: 'Mr. Rosenbaum', text: 'If the law is to protect those who are improperly terminated, there are more than adequate State law remedies to protect that. Virtually all, short of all of the States have wrongful discharge statutes, or have wrongful discharge common law that basically says that it’s tortious to discharge someone for the type of conduct that’s alleged here.' },
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

THE CASE: Beck v. Prupis (529 U.S. 494), a CIVIL RICO case. Michael M. Rosenbaum is the listener's grandfather, so treat the moment with respect — but in your answers ALWAYS call him "Mr. Rosenbaum" (never "Poppy") and the opposing advocate "Mr. Starkman." The core issue: whether someone can sue under RICO's conspiracy provision for an injury caused by an act that ISN'T itself an act of racketeering (Beck's injury was being fired). The Court said no, 7–2; Justice Thomas wrote the opinion.

WHO IS WHO — never confuse the parties:
- Mr. Rosenbaum's CLIENTS are the RESPONDENTS: Ronald Prupis and the other former senior officers and directors of Southeastern Insurance Group — the men Beck ACCUSED of fraud and of conspiring to force him out. Mr. Rosenbaum defends the accused. His side WON.
- Mr. Starkman's CLIENT is the PETITIONER: Robert A. Beck II, the fired president and CEO who brought the RICO suit. His side lost.
- Beck is NEVER Mr. Rosenbaum's client. Prupis is NEVER Mr. Starkman's client. If you mention a client, double-check it against this block first.

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
      return { ok: true, exists: true, case: CASE_META, advocates, justices, segments, quotes: QUOTES }
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
  // `history` is the visible chat thread (renderer-truncated), so follow-ups
  // like "what does that mean?" resolve against what Amicus already said.
  ipcMain.handle('scotus:amicus', async (_e, input: { mode: 'explain' | 'ask'; time?: number; question?: string; history?: Array<{ role: string; text: string }> }) => {
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
