/**
 * The non-answer rule and its judge, measured on the labelled sentences in
 * src/main/__tests__/non-answer.test.ts:
 *
 *   node --experimental-strip-types scripts/non-answer-eval.ts
 *
 * The rule (common/non-answer.ts) decides what it can. Where it says "unsure"
 * the small model is asked one yes/no (common/music-man-ask-prompt.ts), as the
 * app does. Prints how many were settled by each, and every miss. The key is
 * read from the app's own .env files and never printed.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { MODEL_FAST, withModelPolicy } from '../src/common/ai-models.ts'
import { judgeReply } from '../src/common/non-answer.ts'
import { judgePrompt, judgedYes } from '../src/common/music-man-ask-prompt.ts'
const src = readFileSync(join(import.meta.dirname, '..', 'src', 'main', '__tests__', 'non-answer.test.ts'), 'utf8')
// Evaluate the test file's arrays by loading it as data: strip the test code.
const head = src.slice(src.indexOf('const NAMES'), src.indexOf("describe('judgeReply on the labelled set'"))
const mod = await import('data:text/javascript,' + encodeURIComponent(head.replace(/: Array<[^=]+>/, '') + '\nexport { NAMES, NON_ANSWERS, OPINIONS, BATCHES }'))
const rows: Array<{ t: string; names: string[]; non: boolean }> = [
  ...mod.NON_ANSWERS.map((t: string) => ({ t, names: mod.NAMES, non: true })), ...mod.OPINIONS.map((t: string) => ({ t, names: mod.NAMES, non: false })),
  ...mod.BATCHES.flatMap((b: any) => [...b.non.map((t: string) => ({ t, names: b.names, non: true })), ...b.ok.map((t: string) => ({ t, names: b.names, non: false }))]),
]
let key = ''
for (const f of [join(homedir(), 'Library/Application Support/JakeTunes/.env'), join(homedir(), 'JakeTunesV3/.env')]) { try { const m = /^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?([^"'\n]+)/m.exec(readFileSync(f, 'utf8')); if (m) { key = m[1]!.trim(); break } } catch {} }
const a = new Anthropic({ apiKey: key })
const tally = { non: { n: 0, rule: 0, judge: 0, missed: 0 }, ok: { n: 0, rule: 0, judge: 0, wrong: 0 } }
for (const r of rows) {
  const v = judgeReply(r.t, r.names)
  let yes = v === 'non-answer'
  let viaJudge = false
  if (v === 'unsure') {
    const p = judgePrompt(`${r.names[0]} / ${r.names[1]}`, r.t)
    const res = await a.messages.create(withModelPolicy({ model: MODEL_FAST, max_tokens: 5, system: p.system, messages: [{ role: 'user', content: p.user }] }))
    yes = judgedYes(res.content.map((b: any) => b.text ?? '').join(' ')); viaJudge = true
  }
  if (r.non) { tally.non.n++; if (yes && !viaJudge) tally.non.rule++; else if (yes) tally.non.judge++; else { tally.non.missed++; console.log('MISSED', `[${v}]`, r.t) } }
  else { tally.ok.n++; if (!yes && !viaJudge) tally.ok.rule++; else if (!yes) tally.ok.judge++; else { tally.ok.wrong++; console.log('WRONG', `[${v}]`, r.t) } }
}
console.log(JSON.stringify(tally))
