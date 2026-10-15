/**
 * Brief 192 (desktop provenance half) — what build is this, exactly?
 *
 * Two installs can both say "6.0.0" while differing by a month of code
 * (the stale root bundle and the two same-version workmini bundles are
 * the exhibits in the brief). The version string alone cannot answer
 * "is every copy current?" — Brief 195's parity checks compare THIS:
 * app version + the build's commit SHA + build time.
 *
 * The SHA/time come from `build-info.json`, generated at build time by
 * the companion Brief 192 PR (bundle/CI half). This reader is
 * defensive by contract: a dev run, a hand build, or a damaged file
 * must never break boot — absent or unparseable provenance degrades
 * to version + "dev", and the startup log line still prints.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

export interface BuildProvenance {
  version: string
  /** Short commit SHA the build was made from, or 'dev' when unknown. */
  buildSha: string
  /** ISO build timestamp, or null when unknown. */
  builtAt: string | null
}

/** Pure shape-check of a parsed build-info.json. Exported for tests. */
export function parseBuildInfo(raw: unknown, version: string): BuildProvenance {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const sha = typeof o['sha'] === 'string' && o['sha'].trim() ? o['sha'].trim().slice(0, 12) : null
    const builtAt = typeof o['builtAt'] === 'string' && o['builtAt'].trim() ? o['builtAt'].trim() : null
    if (sha) return { version, buildSha: sha, builtAt }
  }
  return { version, buildSha: 'dev', builtAt: null }
}

/**
 * Read build provenance for this install. `dir` is where build-info.json
 * lives in the packaged layout (the app root beside the bundled main);
 * index.ts passes it — tests pass a fixture dir. Never throws.
 */
export function getBuildProvenance(version: string, dir?: string): BuildProvenance {
  try {
    const raw = readFileSync(join(dir ?? __dirname, 'build-info.json'), 'utf-8')
    return parseBuildInfo(JSON.parse(raw) as unknown, version)
  } catch {
    return { version, buildSha: 'dev', builtAt: null }
  }
}

/** The one-line form the startup log and parity payloads share. */
export function formatBuildProvenance(p: BuildProvenance): string {
  return p.builtAt
    ? `JakeTunes ${p.version} (build ${p.buildSha}, built ${p.builtAt})`
    : `JakeTunes ${p.version} (build ${p.buildSha})`
}
