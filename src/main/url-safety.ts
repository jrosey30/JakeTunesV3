/**
 * URL / host allowlists for anything main fetches or opens on behalf of the
 * renderer. Without these, a compromised or XSS'd renderer can turn IPC into
 * SSRF against the LAN (homemini, routers, metadata services) or feed hostile
 * URLs into download CLIs.
 *
 * Deliberately small and explicit — deny-by-default for the generic path.
 */

/** True for loopback, RFC1918, link-local, CGNAT, .local / .internal, and
 *  the house machine names this app already knows about. */
export function isPrivateOrLocalHostname(hostname: string): boolean {
  if (typeof hostname !== 'string' || !hostname) return true
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    h === 'localhost' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h === 'homemini' ||
    h === 'workmini' ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.localhost')
  ) {
    return true
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4])
  if ([a, b, c, d].some((n) => n > 255)) return true
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

function hostMatches(hostname: string, allowed: readonly string[]): boolean {
  const h = hostname.toLowerCase()
  return allowed.some((a) => h === a || h.endsWith('.' + a))
}

const CAPTURE_HOSTS = [
  'open.spotify.com',
  'spotify.com',
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'music.youtube.com',
  'tiktok.com',
  'www.tiktok.com',
  'vm.tiktok.com',
] as const

/** Pasted-link resolver: only known music hosts, never private IPs. */
export function isAllowedCaptureUrl(raw: string): boolean {
  try {
    const u = new URL(String(raw || '').trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    if (isPrivateOrLocalHostname(u.hostname)) return false
    return hostMatches(u.hostname, CAPTURE_HOSTS)
  } catch {
    return false
  }
}

const STREAMRIP_HOSTS = [
  'qobuz.com',
  'www.qobuz.com',
  'open.qobuz.com',
  'tidal.com',
  'www.tidal.com',
  'listen.tidal.com',
  'deezer.com',
  'www.deezer.com',
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'music.youtube.com',
] as const

/** streamrip `rip url …` — only the stores the Download view advertises. */
export function isAllowedStreamripUrl(raw: string): boolean {
  try {
    const u = new URL(String(raw || '').trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    if (isPrivateOrLocalHostname(u.hostname)) return false
    if (/soundcloud\.com$/i.test(u.hostname) || u.hostname.toLowerCase().endsWith('.soundcloud.com')) {
      return false
    }
    return hostMatches(u.hostname, STREAMRIP_HOSTS)
  } catch {
    return false
  }
}

/**
 * Embedded Bandcamp view may navigate to Bandcamp itself, or to the captcha
 * hosts Fastly/Datadome open during bot challenges. Everything else is denied
 * (caller may openExternal https URLs instead).
 */
export function isAllowedBandcampNavUrl(raw: string): boolean {
  try {
    const u = new URL(String(raw || '').trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    const h = u.hostname.toLowerCase()
    if (h === 'bandcamp.com' || h.endsWith('.bandcamp.com')) return true
    if (h === 'captcha-delivery.com' || h.endsWith('.captcha-delivery.com')) return true
    if (h === 'geo.captcha-delivery.com') return true
    // Google reCAPTCHA challenge frames Bandcamp occasionally opens.
    if ((h === 'www.google.com' || h === 'www.gstatic.com') && /recaptcha/i.test(u.pathname + u.search)) {
      return true
    }
    return false
  } catch {
    return false
  }
}

/** Simple sliding-window rate limit. Returns true when the call is allowed. */
export function allowWithinRateLimit(
  bucket: Map<string, number[]>,
  key: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  const recent = (bucket.get(key) || []).filter((t) => now - t < windowMs)
  if (recent.length >= max) {
    bucket.set(key, recent)
    return false
  }
  recent.push(now)
  bucket.set(key, recent)
  return true
}
