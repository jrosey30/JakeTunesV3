/**
 * A small answer cache and a concurrency limit for the Record Shop's
 * catalogue questions (Brief 256).
 *
 * Apple answers 403 to the whole home connection after a few hundred
 * searches, and Qobuz is asked with Jake's own token, so a question already
 * answered is never asked again while its answer is fresh, two callers asking
 * the same thing at once share one request, and a question that got no answer
 * is not asked again for a little while (a page re-rendering must not turn a
 * dead service into a burst). A missing answer is never stored as one: "no
 * answer" is not "no".
 *
 * Pure: the clock is passed in (node --test covers it).
 */

export interface AnswerCache<T> {
  /** The fresh answer for `key`, or undefined (never asked, expired, or failed). */
  get(key: string): T | undefined
  /** True while `key` failed less than `failQuietMs` ago. */
  quiet(key: string): boolean
  /**
   * The answer for `key`: the fresh one, the request already in flight, or a
   * new request through `fetcher`. `fetcher` answering null (or throwing) is
   * no answer: nothing is stored and the key is quiet for `failQuietMs`. A
   * quiet key answers null without asking, unless `force`.
   */
  ask(key: string, fetcher: () => Promise<T | null>, o?: { force?: boolean }): Promise<T | null>
  /** Store an answer directly (a caller that only keeps some answers). */
  put(key: string, value: T): void
  /** How many answers are kept (tests). */
  size(): number
  clear(): void
}

export function createAnswerCache<T>(o: { ttlMs: number; failQuietMs: number; maxEntries: number; now: () => number }): AnswerCache<T> {
  const answers = new Map<string, { at: number; value: T }>()
  const failedAt = new Map<string, number>()
  const inflight = new Map<string, Promise<T | null>>()

  const get = (key: string): T | undefined => {
    const a = answers.get(key)
    if (!a) return undefined
    if (o.now() - a.at >= o.ttlMs) { answers.delete(key); return undefined }
    return a.value
  }
  const quiet = (key: string): boolean => {
    const at = failedAt.get(key)
    if (at === undefined) return false
    if (o.now() - at >= o.failQuietMs) { failedAt.delete(key); return false }
    return true
  }
  const store = (key: string, value: T): void => {
    answers.delete(key)
    answers.set(key, { at: o.now(), value })
    // Oldest first: a Map keeps insertion order, and a re-store moved the key to the end.
    while (answers.size > o.maxEntries) {
      const first = answers.keys().next().value
      if (first === undefined) break
      answers.delete(first)
    }
  }

  return {
    get,
    quiet,
    ask(key, fetcher, opts = {}) {
      const have = get(key)
      if (have !== undefined) return Promise.resolve(have)
      const running = inflight.get(key)
      if (running) return running
      if (!opts.force && quiet(key)) return Promise.resolve(null)
      const p = (async () => {
        let value: T | null = null
        try { value = await fetcher() } catch { value = null }
        if (value === null || value === undefined) failedAt.set(key, o.now())
        else { failedAt.delete(key); store(key, value) }
        return value ?? null
      })().finally(() => { inflight.delete(key) })
      inflight.set(key, p)
      return p
    },
    put: (key, value) => { failedAt.delete(key); store(key, value) },
    size: () => answers.size,
    clear() { answers.clear(); failedAt.clear(); inflight.clear() },
  }
}

/** At most `n` tasks at a time; the rest wait their turn, first come first served. */
export function createLimiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  const next = (): void => {
    if (active >= n) return
    const go = waiting.shift()
    if (go) { active++; go() }
  }
  return <T>(task: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    waiting.push(() => {
      task().then(resolve, reject).finally(() => { active--; next() })
    })
    next()
  })
}
