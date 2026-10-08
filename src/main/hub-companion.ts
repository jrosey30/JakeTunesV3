/**
 * Companion header for homemini hub routes.
 *
 * The hub can require `X-JakeTunes-Companion` (name and env var from the
 * vendored @jaketunes/contracts `companion` block). Enforcement is off
 * today. With no token configured we send no header, so current behavior
 * stays. The token is never logged and never given a default value.
 *
 * ⚠️ TWIN: vendor/jaketunes-contracts/contracts.json `companion.header`
 * and `companion.env`.
 */
export const COMPANION_HEADER = 'X-JakeTunes-Companion'
export const COMPANION_TOKEN_ENV = 'MOBILE_API_TOKEN'

/** Read MOBILE_API_TOKEN from an env-file body. Empty when absent. */
export function parseCompanionToken(text: string): string {
  const match = text.match(/(?:^|\n)\s*(?:export\s+)?MOBILE_API_TOKEN\s*=\s*(.*)\s*$/m)
  if (!match) return ''
  let value = match[1].trim()
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1)
  }
  return value.trim()
}

/**
 * If the process env has no token, copy one out of a userData `.env`
 * body. dotenv normally does this at boot; this covers a miss. Does not
 * log the file or the value.
 */
export function ensureCompanionTokenFromEnvFile(text: string, env: NodeJS.ProcessEnv = process.env): void {
  if ((env[COMPANION_TOKEN_ENV] ?? '').trim()) return
  const token = parseCompanionToken(text)
  if (token) env[COMPANION_TOKEN_ENV] = token
}

export function readCompanionToken(env: NodeJS.ProcessEnv = process.env): string {
  return (env[COMPANION_TOKEN_ENV] ?? '').trim()
}

/** Merge the companion header into a fetch init. No token → init unchanged. */
export function withCompanionInit(init?: RequestInit): RequestInit | undefined {
  const token = readCompanionToken()
  if (!token) return init
  const headers = new Headers(init?.headers)
  headers.set(COMPANION_HEADER, token)
  return { ...init, headers }
}
