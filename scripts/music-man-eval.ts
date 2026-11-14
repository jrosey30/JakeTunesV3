/**
 * How the Music Man sounds when asked, on real things in Jake's library.
 *
 *   node --experimental-strip-types scripts/music-man-eval.ts [out.md]
 *
 * Runs the app's own ask (src/main/music-man-ask.ts) and its own gatherer
 * (src/main/music-man-gather.ts) against this Mac's library and caches, with
 * the app's model and persona, and writes the questions and answers to a
 * Markdown file. Nothing is spoken and nothing in the app's folder is written.
 *
 * Two things differ from the running app, both of which give him LESS to go
 * on here: no press search (Wikipedia / MusicBrainz / Exa ride along in the
 * app), and no library digest or taste profile in the system prompt.
 *
 * The key is read from the app's own .env files and never printed.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { MODEL_SMART, withModelPolicy } from '../src/common/ai-models.ts'
import { LARRY_CORE, MUSIC_MAN_CORE } from '../src/main/personas.ts'
import { createMusicManAsk, type AskHost, type AskResult } from '../src/main/music-man-ask.ts'
import { createMusicManGather, type GatherTrack } from '../src/main/music-man-gather.ts'
import { buildPacket, subjectLabel, type AskSubject } from '../src/common/music-man-packet.ts'
import { isNonAnswer } from '../src/common/non-answer.ts'

const userData = join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const out = process.argv[2] || join(homedir(), 'concert-repair', `music-man-eval-${new Date().toISOString().slice(0, 10)}.md`)

function envValue(name: string): string {
  if (process.env[name]) return process.env[name] as string
  for (const file of [join(userData, '.env'), join(homedir(), 'JakeTunesV3', '.env')]) {
    try {
      const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm').exec(readFileSync(file, 'utf8'))
      if (m?.[1]) return m[1].trim()
    } catch { /* the next file */ }
  }
  return ''
}

const key = envValue('ANTHROPIC_API_KEY')
if (!key) { console.error('No model key in the app\'s .env files.'); process.exit(2) }
const companion = envValue('MOBILE_API_TOKEN') || (() => { try { return readFileSync(join(homedir(), '.config', 'jaketunes', 'companion-token'), 'utf8').trim() } catch { return '' } })()
const anthropic = new Anthropic({ apiKey: key })

const library = JSON.parse(readFileSync(join(userData, 'library.json'), 'utf8')) as { tracks: GatherTrack[]; playlists: Array<{ name: string; trackIds: number[] }> }
const lists = (() => {
  try { return (JSON.parse(readFileSync(join(userData, 'ipod-lists-cache.json'), 'utf8')) as { lists: Array<{ name: string; purpose?: string; ids: number[] }> }).lists } catch { return [] }
})()

const gatherer = createMusicManGather({
  tracks: async () => library.tracks,
  userDataDir: userData,
  hubUrl: process.env.JAKETUNES_MOBILE_BACKEND || 'http://homemini:3000',
  withAuth: (init) => ({ ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...(companion ? { 'X-JakeTunes-Companion': companion } : {}) } }),
})

let calls = 0
function asker(host: AskHost) {
  return createMusicManAsk({
    gather: (s, np) => gatherer.gather(s, np),
    lookHarder: (s, i) => gatherer.lookHarder(s, i),
    activeHost: () => host,
    larryMayChimeIn: () => true,
    // Larry is asked whenever the rate limit lets him, so the file shows him; he still passes when he has nothing.
    random: () => 0,
    model: async (call) => {
      calls++
      const reply = await anthropic.messages.create(withModelPolicy({
        model: MODEL_SMART,
        max_tokens: call.maxTokens,
        system: `${call.host === 'larry' ? LARRY_CORE : MUSIC_MAN_CORE}\n\n${call.instructions}`,
        messages: call.messages,
      }))
      const text = reply.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text').map((b) => b.text).join(' ').trim()
      return { text, cut: reply.stop_reason === 'max_tokens' }
    },
  })
}

const low = (s: unknown): string => String(s ?? '').toLowerCase().trim()
function album(artist: string, name: string): AskSubject {
  const t = library.tracks.find((x) => low(x.album) === low(name) && low(x.albumArtist || x.artist) === low(artist))
    ?? library.tracks.find((x) => low(x.album) === low(name))
  if (!t) throw new Error(`not in the library: ${artist} - ${name}`)
  return { kind: 'album', artist: t.albumArtist || t.artist || artist, album: t.album || name, year: t.year ? String(t.year) : undefined }
}
function song(artist: string, title: string): AskSubject {
  const t = library.tracks.find((x) => low(x.title) === low(title) && low(x.artist) === low(artist))
  if (!t) throw new Error(`not in the library: ${artist} - ${title}`)
  return { kind: 'song', trackId: t.id }
}
function playlist(name: string): AskSubject {
  const p = library.playlists.find((x) => low(x.name) === low(name))
  if (!p) throw new Error(`no playlist ${name}`)
  return { kind: 'list', what: 'playlist', name: p.name, trackIds: p.trackIds }
}
function ipod(name: string): AskSubject {
  const l = lists.find((x) => low(x.name) === low(name))
  if (!l) throw new Error(`no iPod list ${name}`)
  return { kind: 'list', what: 'ipod', name: l.name, trackIds: l.ids, purpose: l.purpose }
}

interface Turn { question?: string; note?: string }
interface Case { title: string; subject: AskSubject; host?: AskHost; turns: Turn[] }

const MIC: Turn = { note: 'mic' }
const cases: Case[] = [
  { title: 'Twisted Teens: "The Holy Cross Tigers" (album page)', subject: album('Twisted Teens', 'The Holy Cross Tigers'),
    turns: [MIC, { question: 'ok where do I start, which song?' }, { question: 'what does Larry think?' }, MIC] },
  { title: 'Star Moles: "Highway to Hell" (album page, small Bandcamp band)', subject: album('Star Moles', 'Highway to Hell'), turns: [MIC, { question: 'is it better than what they did before?' }] },
  { title: 'Man/Woman/Chainsaw: "Cannonball" (album page, small Bandcamp band)', subject: album('Man/Woman/Chainsaw', 'Cannonball'), turns: [MIC] },
  { title: 'The Beatles: "Abbey Road" (album page, a classic)', subject: album('The Beatles', 'Abbey Road'), turns: [MIC, MIC] },
  { title: 'Steely Dan: "Can\'t Buy A Thrill" (album page, a classic)', subject: album('Steely Dan', "Can't Buy A Thrill"), turns: [MIC, { question: 'what does Larry think?' }] },
  { title: 'Kendrick Lamar: "To Pimp A Butterfly" (album page, hip-hop)', subject: album('Kendrick Lamar', 'To Pimp A Butterfly'), turns: [MIC] },
  { title: '"Chef Aid: The South Park Album" (album page, a compilation)', subject: album('Various Artists', 'Chef Aid: The South Park Album'), turns: [MIC] },
  { title: 'Twisted Teens (artist page)', subject: { kind: 'artist', name: 'Twisted Teens' }, turns: [MIC, { question: 'who are they, actually?' }] },
  { title: 'Geese (artist page)', subject: { kind: 'artist', name: 'Geese' }, turns: [MIC] },
  { title: 'A song playing, no page open', subject: song('Charli XCX', '360'), turns: [MIC] },
  { title: 'The punkPod (an iPod\'s list)', subject: ipod('punkPod'), turns: [MIC] },
  { title: '"Greenpoint Greatest Hits" (a playlist)', subject: playlist('Greenpoint Greatest Hits'), turns: [MIC] },
  { title: 'Larry as the chosen host: "The Holy Cross Tigers"', subject: album('Twisted Teens', 'The Holy Cross Tigers'), host: 'larry', turns: [MIC] },
]

const lines: string[] = [
  `# The Music Man, asked: ${new Date().toISOString().slice(0, 10)}`,
  '',
  'Real asks on things in Jake\'s library, through the same code the mic button runs. "mic" is a press of the mic on that page; a quoted line is a typed question. He was given no press search and no taste profile here, so the app gives him more than this.',
  '',
]
let nonAnswers = 0
let answers = 0
for (const c of cases) {
  const ask = asker(c.host ?? 'mm')
  const input = await gatherer.gather(c.subject, c.subject.kind === 'song' ? c.subject.trackId : null)
  const packet = input ? buildPacket(input) : null
  lines.push(`## ${c.title}`, '')
  lines.push(`What he was handed: ${packet ? `${packet.text.length} characters of facts${packet.thin ? ' (nothing written about the artist or the record: the songs and Jake\'s own data only)' : ''}` : 'nothing'}.`, '')
  for (const t of c.turns) {
    const r: AskResult = await ask.ask({ subject: c.subject, question: t.question, nowPlayingId: c.subject.kind === 'song' ? c.subject.trackId : null })
    lines.push(`**Jake** ${t.question ? `"${t.question}"` : `(mic, on ${subjectLabel(c.subject, input?.songs ?? [])})`}`, '')
    if (!r.ok) { lines.push(`_no answer: ${r.error}_`, ''); continue }
    answers++
    if (isNonAnswer(r.text)) nonAnswers++
    lines.push(`**${r.speaker === 'larry' ? 'Larry' : 'The Music Man'}**${r.how === 'model' ? '' : r.how === 'second-try' ? ' _(second try: his first reply said he didn\'t know it and was thrown away)_' : ' _(the plain facts: two replies said he didn\'t know it)_'}: ${r.text}`, '')
    if (r.larry) lines.push(`**Larry**: ${r.larry.text}`, '')
    console.log(`${c.title} / ${t.question ?? 'mic'}: ${r.how}${r.larry ? ' + larry' : ''}`)
  }
}
lines.push('---', '', `${answers} answers, ${nonAnswers} of them saying he didn't know the thing asked about. ${calls} model calls (${MODEL_SMART}).`, '')
writeFileSync(out, lines.join('\n'))
console.log(`wrote ${out}: ${answers} answers, ${nonAnswers} non-answers, ${calls} calls`)
