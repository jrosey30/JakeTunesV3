// Release-gate audit: walk the top library artists through the release gate
// (src/common/release-gate.ts) and print every admitted release and every
// rejection with its reasons, next to what the OLD rules showed.
//
//   node --experimental-strip-types scripts/release-gate-audit.ts <artists.json> <out.json> [--limit N] [--workers N] [--memo memo.json]
//   (--memo keeps every successful response on disk, so a re-run after a rule
//   change asks the network only for what it hasn't seen)
//   node --experimental-strip-types scripts/release-gate-audit.ts --summary <out.json> <out.md> [<recheck.json>]
//
// <artists.json>: [{ name, genre?, albums: [{ title }] }] — names plus the
// library's album titles under each (the identity evidence and the owned set).
//
// Read-only: it only GETs MusicBrainz (1 request/s, with a contact UA),
// Deezer and the iTunes Store (politely). It writes nothing but <out.json>
// and the summary.
//
// What it models, per artist:
//   desktop (Albums + EPs):  OLD = main before the gate (first 100 album|ep
//     release groups, identity guard, secondary types ⊆ Soundtrack, Jake's
//     hidden list). GATE = fetchArtistDiscography's gate verdicts.
//     The tracklist-overlap dedup and the 30-release cap run after both,
//     unchanged, and aren't modelled.
//   phone (Albums, "More from"):  OLD = the phone backend before the gate
//     (score-picked namesake, no secondary types, bootleg regex). GATE =
//     fetchDiscography's gate verdicts. "More from" = not owned.
import { readFileSync, writeFileSync } from 'node:fs'
import {
  gateReleaseGroups, httpGateSources, fetchReleaseGroupsForGate, isHiddenRelease, primaryReason, BOOTLEG_TITLE,
  REJECT_REASONS, type GetJson, type GateReleaseGroup, type GateVerdict, type GateIdentity, type ReleaseSection,
} from '../src/common/release-gate.ts'
import {
  chooseArtistIdentity, albumTitlesMatch, normAlbumTitle, qualifiesAsArtist, pickDiscographyArtist, type MbArtistCandidate,
} from '../src/common/artist-identity.ts'
import { nameKey } from '../src/common/fold-text.ts'

const UA = 'JakeTunes/6.0 (jakerosenbaum30@gmail.com)'
const DESKTOP: ReleaseSection[] = ['album', 'ep']
const PHONE: ReleaseSection[] = ['album']
const match = { fold: nameKey, normTitle: normAlbumTitle, albumMatch: albumTitlesMatch }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function pacer(gapMs: number): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve()
  let last = 0
  return () => {
    const mine = chain.then(async () => {
      const wait = Math.max(0, gapMs - (Date.now() - last))
      if (wait > 0) await sleep(wait)
      last = Date.now()
    })
    chain = mine.catch(() => undefined)
    return mine
  }
}
const pace = { musicbrainz: pacer(1100), deezer: pacer(250), itunes: pacer(3100) }
const stats = { musicbrainz: 0, deezer: 0, itunes: 0, failures: 0 }

// One memo for every URL: the phone and desktop lists share their store and
// MusicBrainz answers. Failures are not memoized.
const memo = new Map<string, unknown>()
const getJson: GetJson = async (url, source) => {
  if (memo.has(url)) return { ok: true, json: memo.get(url) }
  for (let attempt = 0; attempt < 5; attempt++) {
    await pace[source]()
    stats[source]++
    try {
      const res = await fetch(url, { headers: source === 'musicbrainz' ? { 'User-Agent': UA, Accept: 'application/json' } : { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
      if (res.ok) {
        const json = await res.json() as Record<string, unknown>
        // Deezer's quota error arrives as HTTP 200 { error: { code: 4 } }.
        if (source === 'deezer' && (json?.error as { code?: number } | undefined)?.code === 4 && attempt < 4) { await sleep(5000); continue }
        memo.set(url, json)
        return { ok: true, json }
      }
      if ([429, 503, 403].includes(res.status) && attempt < 4) { await sleep((source === 'itunes' ? 20_000 : 3000) * (attempt + 1)); continue }
      stats.failures++
      return { ok: false, status: res.status }
    } catch {
      if (attempt < 4) { await sleep(3000); continue }
      stats.failures++
      return { ok: false, status: null }
    }
  }
  stats.failures++
  return { ok: false, status: null }
}

type ArtistIn = { name: string; genre?: string; albums?: Array<{ title: string }> }
type SurfaceOut = {
  old: string[]
  gate: string[]
  moreFromOld?: string[]
  moreFromGate?: string[]
  verdicts: Array<GateVerdict & { oldShown: boolean }>
}
type ArtistOut = {
  name: string
  mbid?: string
  identity?: GateIdentity | null
  identityOk?: boolean
  identityWhy?: string
  phoneMbid?: string | null
  phoneIdentity?: GateIdentity | null
  complete?: boolean
  desktop?: SurfaceOut
  phone?: SurfaceOut
  error?: string
}

async function searchArtists(name: string): Promise<Array<MbArtistCandidate & { type?: string; tags?: Array<{ name: string }> }>> {
  const r = await getJson(`https://musicbrainz.org/ws/2/artist/?query=artist:"${encodeURIComponent(name)}"&fmt=json&limit=10`, 'musicbrainz')
  if (!r.ok) throw new Error('MusicBrainz search failed')
  const artists = ((r.json as { artists?: Array<Record<string, unknown>> }).artists ?? [])
  return artists.map((a) => ({
    id: String(a.id ?? ''), name: String(a.name ?? ''), score: Number(a.score ?? 0), type: String(a.type ?? ''),
    tags: (a.tags as Array<{ name: string }> | undefined) ?? [],
    aliases: ((a.aliases as Array<{ name?: string }> | undefined) ?? []).map((x) => x.name ?? '').filter(Boolean),
  }))
}

async function albumTitles(mbid: string, types: string): Promise<string[]> {
  const r = await getJson(`https://musicbrainz.org/ws/2/release-group?artist=${mbid}&type=${types}&fmt=json&limit=100`, 'musicbrainz')
  if (!r.ok) throw new Error('MusicBrainz release-group browse failed')
  return ((r.json as { 'release-groups'?: Array<{ title?: string }> })['release-groups'] ?? []).map((g) => g.title ?? '').filter(Boolean)
}

const owns = (owned: string[], title: string) => owned.some((o) => albumTitlesMatch(o, title))

async function auditArtist(a: ArtistIn): Promise<ArtistOut> {
  const name = a.name
  const owned = (a.albums ?? []).map((x) => x.title).filter(Boolean)
  const out: ArtistOut = { name }
  const found = await searchArtists(name)
  const people = found.filter((c) => c.type === 'Person' || c.type === 'Group')
  // Desktop resolver: MB score + library-genre tag boost orders the evidence;
  // owned-album overlap settles namesakes (chooseArtistIdentity).
  const genre = (a.genre ?? '').toLowerCase()
  const ranked = people.map((c) => ({ c, s: (c.score ?? 0) + ((c.tags ?? []).some((t) => genre && (t.name.toLowerCase().includes(genre) || genre.includes(t.name.toLowerCase()))) ? 25 : 0) }))
    .sort((x, y) => y.s - x.s).map((x) => x.c)
  const evidence = new Map<string, string[]>()
  const chosen = await chooseArtistIdentity({
    name, ranked, ownedAlbums: owned, fold: nameKey,
    fetchReleaseGroups: async (id) => { const t = await albumTitles(id, 'album|ep'); evidence.set(id, t); return t },
  })
  if (!chosen?.candidate?.id) { out.identity = null; out.identityOk = false; out.identityWhy = 'no MusicBrainz artist'; return out }
  const mbid = chosen.candidate.id
  out.mbid = mbid
  out.identity = chosen.identity

  // Every album|ep release group, paged (the gate's browse).
  const browse = await fetchReleaseGroupsForGate(mbid, DESKTOP, getJson)
  const groups = browse.groups
  // The phone and desktop share one official scan (album|ep is a superset of album).
  const deps = { ...match, ...httpGateSources(getJson, DESKTOP) }

  // ── desktop ──
  const firstPage = groups.slice(0, 100)
  const witnesses = owned.filter((t) => normAlbumTitle(t))
  const someoneElses = witnesses.length > 0 && !firstPage.some((g) => witnesses.some((o) => albumTitlesMatch(o, g.title)))
  const oldDesk = chosen.identity === 'ambiguous' || someoneElses ? [] : firstPage
    .filter((g) => g.primaryType === 'Album' || g.primaryType === 'EP')
    .filter((g) => g.secondaryTypes.every((s) => s.toLowerCase() === 'soundtrack'))
    .filter((g) => !isHiddenRelease(mbid, g.title))
  const oldDeskIds = new Set(oldDesk.map((g) => g.id))
  const deskGate = await gateReleaseGroups({
    artist: name, artistNames: [chosen.candidate.name ?? name], mbid, identity: chosen.identity, identityIncomplete: chosen.incomplete,
    sections: DESKTOP, releaseGroups: groups, ownedAlbums: owned,
  }, deps)
  out.identityOk = deskGate.identity.ok
  out.identityWhy = deskGate.identity.why
  out.desktop = {
    old: oldDesk.map((g) => g.title),
    gate: deskGate.verdicts.filter((v) => v.admitted).map((v) => v.title),
    verdicts: deskGate.verdicts.map((v) => ({ ...v, oldShown: oldDeskIds.has(v.id) })),
  }

  // ── phone ──
  // OLD resolver: exact name/alias at the score floor; namesakes by overlap,
  // else MusicBrainz score (a guess). NEW: the same pick, but confirmed only
  // when it owns a library album.
  const qualifiers = found.filter((c) => qualifiesAsArtist(c, name, nameKey))
  let phoneMbid: string | null = null
  let phoneIdentity: GateIdentity | null = null
  if (qualifiers.length === 1) { phoneMbid = qualifiers[0]!.id!; phoneIdentity = 'single' }
  else if (qualifiers.length > 1) {
    const top = [...qualifiers].sort((x, y) => (y.score ?? 0) - (x.score ?? 0)).slice(0, 5)
    for (const c of top) c.releaseGroups = evidence.get(c.id!) ?? await albumTitles(c.id!, 'album')
    const picked = pickDiscographyArtist(found, name, owned, nameKey, albumTitlesMatch)
    phoneMbid = picked?.id ?? null
    phoneIdentity = picked ? ((picked.releaseGroups ?? []).some((t) => owns(owned, t)) ? 'confirmed' : 'ambiguous') : 'ambiguous'
  }
  out.phoneMbid = phoneMbid
  out.phoneIdentity = phoneIdentity
  if (phoneMbid) {
    const phoneGroups: GateReleaseGroup[] = phoneMbid === mbid ? groups : (await fetchReleaseGroupsForGate(phoneMbid, DESKTOP, getJson)).groups
    const albumsOnly = phoneGroups.filter((g) => (g.primaryType ?? '').toLowerCase() === 'album')
    const seen = new Set<string>()
    const oldPhone = albumsOnly.slice(0, 100).filter((g) => {
      if (g.secondaryTypes.length > 0 || BOOTLEG_TITLE.test(g.title)) return false
      const k = g.title.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    const oldPhoneIds = new Set(oldPhone.map((g) => g.id))
    const phoneGate = await gateReleaseGroups({
      artist: name, artistNames: [chosen.candidate.name ?? name], mbid: phoneMbid, identity: phoneIdentity,
      sections: PHONE, releaseGroups: albumsOnly, ownedAlbums: owned,
    }, { ...match, ...httpGateSources(getJson, DESKTOP) })
    const admitted = phoneGate.verdicts.filter((v) => v.admitted).map((v) => v.title)
    out.phone = {
      old: oldPhone.map((g) => g.title),
      gate: admitted,
      moreFromOld: oldPhone.map((g) => g.title).filter((t) => !owns(owned, t)),
      moreFromGate: admitted.filter((t) => !owns(owned, t)),
      verdicts: phoneGate.verdicts.map((v) => ({ ...v, oldShown: oldPhoneIds.has(v.id) })),
    }
    out.complete = browse.complete && deskGate.complete && phoneGate.complete
  } else {
    out.phone = { old: [], gate: [], moreFromOld: [], moreFromGate: [], verdicts: [] }
    out.complete = browse.complete && deskGate.complete
  }
  return out
}

// ── summary ──────────────────────────────────────────────────────────────

function summarize(rows: ArtistOut[], crossCheckPath?: string): string {
  const lines: string[] = []
  const ok = rows.filter((r) => !r.error)
  const surface = (key: 'desktop' | 'phone') => {
    let oldN = 0, gateN = 0, oldRejected = 0, newlyAdmitted = 0, excused = 0, transient = 0
    const byPrimary = new Map<string, number>()
    const byAny = new Map<string, number>()
    const offenders: Array<{ name: string; n: number; titles: string[] }> = []
    for (const r of ok) {
      const s = r[key]
      if (!s) continue
      oldN += s.old.length
      gateN += s.gate.length
      const rej = s.verdicts.filter((v) => v.oldShown && !v.admitted)
      oldRejected += rej.length
      newlyAdmitted += s.verdicts.filter((v) => !v.oldShown && v.admitted).length
      excused += s.verdicts.filter((v) => v.admitted && v.reasons.length > 0).length
      transient += s.verdicts.filter((v) => v.transient).length
      for (const v of rej) {
        const p = primaryReason(v) ?? 'none'
        byPrimary.set(p, (byPrimary.get(p) ?? 0) + 1)
        for (const x of v.reasons) byAny.set(x, (byAny.get(x) ?? 0) + 1)
      }
      if (rej.length) offenders.push({ name: r.name, n: rej.length, titles: rej.map((v) => `${v.title} (${v.reasons.join('+')})`) })
    }
    offenders.sort((a, b) => b.n - a.n)
    return { oldN, gateN, oldRejected, newlyAdmitted, excused, transient, byPrimary, byAny, offenders }
  }
  const d = surface('desktop')
  const p = surface('phone')
  const mfOld = ok.reduce((n, r) => n + (r.phone?.moreFromOld?.length ?? 0), 0)
  const mfGate = ok.reduce((n, r) => n + (r.phone?.moreFromGate?.length ?? 0), 0)
  lines.push('# Release gate audit: top library artists', '')
  lines.push(`Artists: ${rows.length} (${rows.filter((r) => r.error).length} errored, ${ok.filter((r) => r.complete === false).length} incomplete). Requests: MusicBrainz ${stats.musicbrainz}, Deezer ${stats.deezer}, iTunes ${stats.itunes}.`, '')
  lines.push('## Old rules vs the gate', '')
  lines.push('| List | Old rules showed | Gate admits | Old entries the gate rejects | Admitted now, not shown before |', '|---|---:|---:|---:|---:|')
  lines.push(`| Desktop discography (albums + EPs) | ${d.oldN} | ${d.gateN} | ${d.oldRejected} | ${d.newlyAdmitted} |`)
  lines.push(`| Phone discography (albums) | ${p.oldN} | ${p.gateN} | ${p.oldRejected} | ${p.newlyAdmitted} |`)
  const mfRejected = ok.reduce((n, r) => {
    const mf = new Set(r.phone?.moreFromOld ?? [])
    return n + (r.phone?.verdicts ?? []).filter((v) => v.oldShown && !v.admitted && mf.has(v.title)).length
  }, 0)
  lines.push(`| Phone "More from" (albums not owned) | ${mfOld} | ${mfGate} | ${mfRejected} | |`, '')
  for (const [label, s] of [['Desktop', d], ['Phone', p]] as const) {
    lines.push(`## ${label}: why old entries were rejected`, '')
    lines.push('| Reason | Primary (first that applies) | Any |', '|---|---:|---:|')
    for (const reason of REJECT_REASONS) {
      const prim = s.byPrimary.get(reason) ?? 0
      const any = s.byAny.get(reason) ?? 0
      if (prim || any) lines.push(`| ${reason} | ${prim} | ${any} |`)
    }
    lines.push('', `Owned releases admitted despite a failed reality check: ${s.excused}. Transient (source down) rejections: ${s.transient}.`, '')
    lines.push(`### ${label}: top offenders`, '')
    for (const o of s.offenders.slice(0, 15)) lines.push(`- **${o.name}** (${o.n}): ${o.titles.slice(0, 8).join('; ')}${o.titles.length > 8 ? '; ...' : ''}`)
    lines.push('')
  }
  const refused = ok.filter((r) => r.identityOk === false)
  lines.push('## Identity refusals (nothing admitted)', '')
  for (const r of refused) lines.push(`- ${r.name}: ${r.identity ?? 'none'}, ${r.identityWhy} (old desktop showed ${r.desktop?.old.length ?? 0}, old phone ${r.phone?.old.length ?? 0})`)
  if (!refused.length) lines.push('- none')
  lines.push('')
  const errs = rows.filter((r) => r.error)
  if (errs.length) { lines.push('## Errors', ''); for (const r of errs) lines.push(`- ${r.name}: ${r.error}`); lines.push('') }
  if (crossCheckPath) {
    // A separate, per-group verification (recheck.json): every "phony" title
    // has no Official release on MusicBrainz; every "real" one does.
    try {
      const other = JSON.parse(readFileSync(crossCheckPath, 'utf-8')) as Array<{ name: string; phony?: Array<{ title: string; phoneList?: boolean; deskList?: boolean }>; real?: string[] }>
      const key = (t: string) => t.normalize('NFKC').toLowerCase().trim()
      let phonyN = 0, phonyRejected = 0, realN = 0, realAdmitted = 0
      const phonyAdmitted: string[] = []
      const phonyUnseen: string[] = []
      const realRejected: string[] = []
      for (const o of other) {
        const r = ok.find((x) => x.name === o.name)
        if (!r) continue
        const all = [...(r.desktop?.verdicts ?? []), ...(r.phone?.verdicts ?? [])]
        const refused = r.identityOk === false
        for (const p of o.phony ?? []) {
          phonyN++
          const vs = all.filter((v) => key(v.title) === key(p.title))
          if (refused || (vs.length && !vs.some((v) => v.admitted))) { phonyRejected++; continue }
          if (!vs.length) { phonyUnseen.push(`${o.name}: ${p.title}`); continue }
          const v = vs.find((x) => x.admitted)!
          const clean = vs.filter((x) => x.admitted && x.reasons.length === 0).length
          phonyAdmitted.push(`${o.name}: ${p.title} (${v.owned ? `owned — ${v.notes.join('; ')}` : clean ? 'another release group with this title IS official' : v.notes.join('; ')})`)
        }
        for (const t of o.real ?? []) {
          realN++
          const vs = all.filter((v) => key(v.title) === key(t))
          if (vs.some((v) => v.admitted)) { realAdmitted++; continue }
          realRejected.push(`${o.name}: ${t} (${refused ? `identity: ${r.identityWhy}` : vs.length ? [...new Set(vs.map((v) => v.reasons.join('+')))].join(' / ') : 'not in the gate lists'})`)
        }
      }
      lines.push('## Cross-check: the per-group phony verification (recheck.json)', '')
      lines.push(`- "phony" (no Official release): ${phonyN}. Rejected by the gate: ${phonyRejected}. Admitted: ${phonyAdmitted.length}. Not in the gate's lists: ${phonyUnseen.length}.`)
      lines.push(`- "real" (Official after all): ${realN}. Admitted by the gate: ${realAdmitted}. Rejected by another rule: ${realRejected.length}.`, '')
      if (phonyAdmitted.length) { lines.push('Phony titles the gate admits:', ''); for (const x of phonyAdmitted) lines.push(`- ${x}`); lines.push('') }
      if (phonyUnseen.length) { lines.push('Phony titles not in the gate lists (paging/identity differences):', ''); for (const x of phonyUnseen.slice(0, 40)) lines.push(`- ${x}`); lines.push('') }
      if (realRejected.length) { lines.push('Real titles the gate rejects, and why:', ''); for (const x of realRejected) lines.push(`- ${x}`); lines.push('') }
    } catch (e) { lines.push(`(cross-check skipped: ${String(e)})`, '') }
  }
  return lines.join('\n')
}

// ── main ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
if (args[0] === '--summary') {
  const rows = JSON.parse(readFileSync(args[1]!, 'utf-8')) as { artists: ArtistOut[]; stats?: typeof stats }
  if (rows.stats) Object.assign(stats, rows.stats)
  writeFileSync(args[2]!, summarize(rows.artists, args[3]))
  console.log(`wrote ${args[2]}`)
} else {
  const [inPath, outPath] = args
  if (!inPath || !outPath) { console.error('usage: release-gate-audit.ts <artists.json> <out.json> [--limit N] [--workers N]'); process.exit(2) }
  const limitAt = args.indexOf('--limit')
  const workersAt = args.indexOf('--workers')
  const memoAt = args.indexOf('--memo')
  const memoPath = memoAt > 0 ? args[memoAt + 1] : undefined
  if (memoPath) {
    try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(memoPath, 'utf-8')) as Record<string, unknown>)) memo.set(k, v) } catch { /* first run */ }
    console.log(`memo: ${memo.size} responses`)
  }
  const limit = limitAt > 0 ? Number(args[limitAt + 1]) : 200
  const workers = workersAt > 0 ? Number(args[workersAt + 1]) : 3
  const artists = (JSON.parse(readFileSync(inPath, 'utf-8')) as ArtistIn[]).slice(0, limit)
  const results: ArtistOut[] = new Array(artists.length)
  let next = 0
  let done = 0
  const save = () => {
    writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), stats, artists: results.filter(Boolean) }, null, 1))
    if (memoPath) writeFileSync(memoPath, JSON.stringify(Object.fromEntries(memo)))
  }
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const i = next++
      if (i >= artists.length) return
      const a = artists[i]!
      try { results[i] = await auditArtist(a) } catch (e) { results[i] = { name: a.name, error: String(e) } }
      done++
      const r = results[i]!
      const rej = (r.desktop?.verdicts ?? []).filter((v) => v.oldShown && !v.admitted).map((v) => `${v.title} [${v.reasons.join('+')}]`)
      console.log(`[${done}/${artists.length}] ${a.name}: ${r.error ? `ERROR ${r.error}` : `desktop ${r.desktop?.old.length}→${r.desktop?.gate.length}, phone ${r.phone?.old.length}→${r.phone?.gate.length}${r.complete === false ? ' INCOMPLETE' : ''}${rej.length ? ` | rejected: ${rej.join('; ')}` : ''}`}`)
      if (done % 5 === 0) save()
    }
  }))
  save()
  console.log(`DONE ${artists.length} artists; MB ${stats.musicbrainz}, Deezer ${stats.deezer}, iTunes ${stats.itunes}, failures ${stats.failures}`)
}
