#!/usr/bin/env node
/**
 * artist-members — teach the brain who is IN a group, grounded in MusicBrainz.
 *
 * Jake, 2026-09-04: "need ai brain to know that Huncho Jack is Quavo and
 * Travis Scott somehow". Nothing in the library says so: the tag is a single
 * clean name (so the "X & Y" grouping pass never sees it), and the brain's
 * text for the track is just artist/title/album/genre. MusicBrainz knows:
 * HUNCHO JACK is type Group with "member of band" relations to Quavo and
 * Travis Scott. This script asks MusicBrainz for every distinct artist tag in
 * the library, keeps the members of anything typed Group/Orchestra/Choir,
 * and writes STATE_DIR/artist-members.json:
 *
 *   { "<artist tag as in library.json>": { mbid, type, members: [..], at } }
 *
 * Negative results are cached too ("Person", or no exact match), so a rerun
 * only asks about new tags. The sidecar rides to the NAS with the other state
 * files; the nightly brain-trainer folds `members:` into each track's text
 * (⚠️ TWIN: src/main/ai/embeddings.ts buildEmbeddingText) and the RAG router
 * counts member names as library artists.
 *
 * Grounded, never guessed (feedback_ground_ai_facts): only an EXACT
 * folded-name match at score 100 counts; anything fuzzier is recorded as
 * "none". MusicBrainz asks for 1 request/second with a real User-Agent.
 *
 *   node scripts/artist-members.mjs                # all uncached tags
 *   node scripts/artist-members.mjs --only "Huncho Jack"
 *   node scripts/artist-members.mjs --limit 200    # budget a run
 *   node scripts/artist-members.mjs --refresh      # re-ask cached tags too
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const STATE_DIR = process.env.JT_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const LIB = join(STATE_DIR, 'library.json')
const OUT = join(STATE_DIR, 'artist-members.json')
const UA = 'JakeTunes/6.0 ( jakerosenbaum30@gmail.com )'
const GROUP_TYPES = new Set(['Group', 'Orchestra', 'Choir'])

const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const only = flag('--only')
const limit = Number(flag('--limit') || 0)
const refresh = args.includes('--refresh')

/**
 * Curated groups MusicBrainz does not model as bands (label compilations
 * credited to a collective, one-off duos). Always applied, never asked,
 * survive --refresh. Grounded by Jake (2026-09-04), not by an LLM.
 */
const CURATED = {
  'Quality Control': ['Migos', 'Lil Yachty'],   // Control The Streets — Jake 9/4
  'Huncho Jack': ['Quavo', 'Travis Scott'],     // MB has it too; pinned so it can never drift
}

function fold(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function mb(path) {
  const res = await fetch('https://musicbrainz.org/ws/2/' + path, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
  if (res.status === 503 || res.status === 429) { await sleep(5000); return mb(path) }
  if (!res.ok) throw new Error(`musicbrainz ${res.status} for ${path}`)
  return res.json()
}

async function membersOf(tag) {
  const q = encodeURIComponent(`artist:"${tag.replace(/"/g, '')}"`)
  const s = await mb(`artist/?query=${q}&fmt=json&limit=5`)
  await sleep(1100)
  const exact = (s.artists || []).find((a) => Number(a.score) === 100 && fold(a.name) === fold(tag))
  if (!exact) return { type: 'none', members: [] }
  if (!GROUP_TYPES.has(exact.type)) return { mbid: exact.id, type: exact.type || 'Person', members: [] }
  const d = await mb(`artist/${exact.id}?inc=artist-rels&fmt=json`)
  await sleep(1100)
  const members = []
  for (const r of d.relations || []) {
    if (r.type !== 'member of band' || r.direction !== 'backward') continue
    const name = r.artist?.name
    if (name && !members.includes(name)) members.push(name)
  }
  return { mbid: exact.id, type: exact.type, members }
}

const lib = JSON.parse(readFileSync(LIB, 'utf8'))
const tracks = Array.isArray(lib) ? lib : lib.tracks
const tags = new Map()
for (const t of tracks) for (const a of [t.artist, t.albumArtist]) {
  const s = String(a || '').trim(); if (!s) continue
  tags.set(s, (tags.get(s) || 0) + 1)
}
let cache = {}
if (existsSync(OUT)) { try { cache = JSON.parse(readFileSync(OUT, 'utf8')) } catch { cache = {} } }
const save = () => { writeFileSync(OUT + '.tmp', JSON.stringify(cache, null, 1)); renameSync(OUT + '.tmp', OUT) }

let todo = [...tags.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag)
if (only) todo = todo.filter((t) => fold(t) === fold(only))
for (const [tag, members] of Object.entries(CURATED)) cache[tag] = { ...(cache[tag] || {}), type: 'curated', members, at: new Date().toISOString() }
todo = todo.filter((t) => !CURATED[t])
if (!refresh) todo = todo.filter((t) => !cache[t])
if (limit > 0) todo = todo.slice(0, limit)
console.log(`artist-members: ${tags.size} distinct tags, ${Object.keys(cache).length} cached, ${todo.length} to ask`)
let asked = 0, groups = 0
for (const tag of todo) {
  try {
    const r = await membersOf(tag)
    cache[tag] = { ...r, at: new Date().toISOString() }
    asked++
    if (r.members.length) { groups++; console.log(`  ${tag} = ${r.members.join(', ')}`) }
    if (asked % 10 === 0) save()
  } catch (e) {
    console.warn(`  ${tag}: ${e.message}`)
    await sleep(3000)
  }
}
save()
console.log(`done: asked ${asked}, groups with members ${groups}, total cached ${Object.keys(cache).length} -> ${OUT}`)
