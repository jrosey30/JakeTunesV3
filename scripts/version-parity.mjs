#!/usr/bin/env node
/**
 * Brief 195 — version parity: "is every copy current?", answered in one run.
 *
 * For each candidate install location, reads:
 *   - version (Contents/Info.plist → CFBundleShortVersionString)
 *   - app.asar size + mtime (Contents/Resources/app.asar)
 *   - build provenance (Brief 192's build-info.json — plain file at
 *     Contents/Resources/build-info.json, or `out/main/build-info.json`
 *     inside app.asar, read via the minimal asar reader below)
 * …and compares against the newest known build: the latest GitHub
 * Release of JakeTunesV3 (public repo; unauthenticated fetch, graceful
 * failure offline) and the other installs themselves.
 *
 * MISMATCH-ONLY reporting: when everything matches, text mode prints
 * nothing and exits 0. Any mismatch prints one line per problem and
 * exits 1. `--json` always prints the full payload (for the weekly
 * digest to fold in — that folding is an ops step, not this script).
 *
 * Locations: positional args, else $JT_PARITY_APPS (colon-separated),
 * else the defaults:
 *   /Applications/JakeTunes.app, ~/Applications/JakeTunes.app,
 *   ~/JakeTunes-prev.app
 * Test/offline seam: $JT_PARITY_RELEASE_JSON = path to a saved
 * api.github.com releases/latest response, read instead of fetching.
 *
 * Explicitly NOT this script: publishing the v6.0.0 GitHub Release
 * (a manual Mac-side act — `npm run release` from the 6.0.0 source).
 * When no release exists past the installed version, this report is
 * what makes that absence impossible to miss.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const RELEASE_URL = 'https://api.github.com/repos/jrosey30/JakeTunesV3/releases/latest'

function defaultLocations() {
  if (process.env.JT_PARITY_APPS) return process.env.JT_PARITY_APPS.split(':').filter(Boolean)
  return [
    '/Applications/JakeTunes.app',
    join(homedir(), 'Applications', 'JakeTunes.app'),
    join(homedir(), 'JakeTunes-prev.app'),
  ]
}

function plistString(plist, key) {
  // Info.plist is XML: <key>KEY</key> followed by <string>VALUE</string>.
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))
  return m ? m[1] : null
}

/**
 * Minimal asar reader: returns the bytes of one entry, or null. Never throws.
 * Layout: [u32 4][u32 headerSize], then the header pickle
 * [u32 payloadSize][u32 jsonLen][json…]; file data starts at 8 + headerSize.
 */
function readAsarEntry(asarPath, entryPath) {
  try {
    const buf = readFileSync(asarPath)
    if (buf.length < 16) return null
    const headerPickleSize = buf.readUInt32LE(4)
    const headerPickle = buf.subarray(8, 8 + headerPickleSize)
    const jsonLen = headerPickle.readUInt32LE(4)
    const header = JSON.parse(headerPickle.subarray(8, 8 + jsonLen).toString('utf8'))
    let node = header
    for (const part of entryPath.split('/')) {
      node = node?.files?.[part]
      if (!node) return null
    }
    if (node.unpacked || typeof node.offset !== 'string' || typeof node.size !== 'number') return null
    const dataStart = 8 + headerPickleSize
    const start = dataStart + Number(node.offset)
    return buf.subarray(start, start + node.size)
  } catch {
    return null
  }
}

function parseBuildInfo(raw) {
  try {
    const o = JSON.parse(raw)
    if (o && typeof o === 'object') {
      const sha = typeof o.sha === 'string' && o.sha.trim() ? o.sha.trim() : null
      const builtAt = typeof o.builtAt === 'string' && o.builtAt.trim() ? o.builtAt.trim() : null
      if (sha) return { buildSha: sha.slice(0, 12), builtAt }
    }
  } catch { /* fall through */ }
  return null
}

function inspectInstall(appPath) {
  const out = {
    path: appPath, present: existsSync(appPath), version: null,
    asarSize: null, asarMtime: null, buildSha: null, builtAt: null,
  }
  if (!out.present) return out
  try {
    const plist = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8')
    out.version = plistString(plist, 'CFBundleShortVersionString') || plistString(plist, 'CFBundleVersion')
  } catch { /* version stays null — reported as unreadable below */ }
  const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar')
  try {
    const st = statSync(asarPath)
    out.asarSize = st.size
    out.asarMtime = st.mtime.toISOString()
  } catch { /* no asar — version-only install */ }
  // Provenance: plain file beside the asar first, then inside the asar
  // at the path Brief 192's stamper writes (out/main/build-info.json).
  const plain = join(appPath, 'Contents', 'Resources', 'build-info.json')
  if (existsSync(plain)) {
    const p = parseBuildInfo(readFileSync(plain, 'utf8'))
    if (p) { out.buildSha = p.buildSha; out.builtAt = p.builtAt }
  }
  if (!out.buildSha && out.asarSize !== null) {
    const entry = readAsarEntry(asarPath, 'out/main/build-info.json')
    if (entry) {
      const p = parseBuildInfo(entry.toString('utf8'))
      if (p) { out.buildSha = p.buildSha; out.builtAt = p.builtAt }
    }
  }
  return out
}

async function fetchLatestRelease() {
  const seam = process.env.JT_PARITY_RELEASE_JSON
  if (seam) {
    try { return JSON.parse(readFileSync(seam, 'utf8')) } catch { return null }
  }
  try {
    const res = await fetch(RELEASE_URL, {
      headers: { 'user-agent': 'jaketunes-version-parity', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null // offline / rate-limited — parity vs local copies still runs
  }
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const locations = args.filter((a) => !a.startsWith('--'))
const installs = (locations.length ? locations : defaultLocations()).map(inspectInstall)
const release = await fetchLatestRelease()
const releaseVersion = release?.tag_name ? String(release.tag_name).replace(/^v/, '') : null

const present = installs.filter((i) => i.present)
const newestLocal = present.reduce(
  (best, i) => (i.version && (!best || cmpVersion(i.version, best) > 0) ? i.version : best),
  null,
)
const referenceVersion = releaseVersion ?? newestLocal

const mismatches = []
for (const i of installs) {
  if (!i.present) {
    mismatches.push({ path: i.path, issue: 'missing — no app bundle at this location' })
    continue
  }
  if (!i.version) {
    mismatches.push({ path: i.path, issue: 'unreadable — Info.plist version not found' })
    continue
  }
  if (referenceVersion && cmpVersion(i.version, referenceVersion) !== 0) {
    mismatches.push({
      path: i.path,
      issue: `version ${i.version} != newest known ${referenceVersion}` +
        (releaseVersion ? ' (latest GitHub Release)' : ' (newest local install)'),
    })
  }
}
// Cross-install: same version string must mean the same build.
const byVersion = new Map()
for (const i of present) {
  if (!i.version) continue
  if (!byVersion.has(i.version)) byVersion.set(i.version, [])
  byVersion.get(i.version).push(i)
}
for (const [version, group] of byVersion) {
  if (group.length < 2) continue
  const shas = new Set(group.map((g) => g.buildSha).filter(Boolean))
  if (shas.size > 1) {
    for (const g of group) {
      mismatches.push({ path: g.path, issue: `same version ${version} but build ${g.buildSha} differs across installs` })
    }
    continue
  }
  if (shas.size === 1) {
    for (const g of group) {
      if (!g.buildSha) {
        mismatches.push({ path: g.path, issue: `version ${version} with no build provenance — cannot prove it is the same build as the stamped copy` })
      }
    }
    continue
  }
  const sizes = new Set(group.map((g) => g.asarSize).filter((s) => s !== null))
  if (sizes.size > 1) {
    for (const g of group) {
      mismatches.push({ path: g.path, issue: `same version ${version}, no provenance, app.asar sizes differ (${[...sizes].join(' vs ')} bytes) — the two-bundles-one-version failure` })
    }
  }
}

const payload = {
  brief: 195,
  checkedAt: new Date().toISOString(),
  reference: release
    ? { version: releaseVersion, tag: release.tag_name, publishedAt: release.published_at ?? null }
    : null,
  referenceVersion,
  installs,
  mismatches,
}

if (jsonMode) {
  console.log(JSON.stringify(payload, null, 2))
} else if (mismatches.length > 0) {
  console.log(`version parity: ${mismatches.length} mismatch(es) (newest known: ${referenceVersion ?? 'unknown'})`)
  for (const m of mismatches) console.log(`MISMATCH ${m.path}: ${m.issue}`)
}
process.exit(mismatches.length > 0 ? 1 : 0)
