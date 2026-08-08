#!/usr/bin/env node
/**
 * artgen — GPT Image 2 artwork generation on the existing OpenAI key
 * (2026-08-07, Jake: "onboard chatgpt api for aesthetic creative work").
 *
 * The aesthetic layer of the system: mixtape J-cards, playlist covers,
 * posters — anything where generated ART beats generated SVG. Claude
 * (or any script) shells out here; the key stays in .env and never
 * transits chat.
 *
 *   node scripts/artgen.mjs --prompt "..." --out cover.png
 *     [--size 1024x1024|1024x1536|1536x1024] [--quality low|medium|high]
 *     [--model gpt-image-2]
 *
 * Cost discipline: medium ≈ $0.03–0.06/image; default is medium. Use
 * --quality low for drafts/iteration, high only for a final print.
 * gpt-image-1 deprecates 2026-10-23 — do not pin it anywhere.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1], i++
}
if (!args.prompt || !args.out) {
  console.error('usage: artgen.mjs --prompt "..." --out file.png [--size WxH] [--quality low|medium|high] [--model id]')
  process.exit(2)
}

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
const key = readFileSync(envPath, 'utf8').match(/^OPENAI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) { console.error('OPENAI_API_KEY missing from repo .env'); process.exit(1) }

const body = {
  model: args.model || 'gpt-image-2',
  prompt: args.prompt,
  size: args.size || '1024x1024',
  quality: args.quality || 'medium',
  n: 1,
}
const res = await fetch('https://api.openai.com/v1/images/generations', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json())

if (res.error) { console.error(`artgen: ${res.error.message}`); process.exit(1) }
const b64 = res.data?.[0]?.b64_json
if (!b64) { console.error('artgen: no image in response'); process.exit(1) }
writeFileSync(args.out, Buffer.from(b64, 'base64'))
console.log(`${args.out} (${body.model}, ${body.size}, ${body.quality})`)
