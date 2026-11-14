/**
 * Update ready — the watcher + IPC shell around update-ready-core.ts (2026-10-30)
 * and update-decision-core.ts (2026-11-14).
 *
 * The install gate (scripts/install/jaketunes-install-gate.sh) writes
 * `update-ready.json` into userData while it waits to swap the app. This
 * module watches that file the way index.ts watches library.json (fs.watch +
 * a 15 s mtime poll as the backstop), judges it with the pure core, and pushes
 * `update-ready` to the renderer — or null when the marker goes away or stops
 * counting (the gate was killed, the marker aged out, the build it names is
 * the one now running, Jake skipped it).
 *
 *   'update-ready:get'     → { ok, state }    what the renderer draws on mount
 *   'update-ready:decide'  → { ok, error? }   Jake's answer: { choice: 'now' }
 *                              | { choice: 'at', at } | { choice: 'skip' }.
 *                              Saved in update-decision.json FIRST, then acted on.
 *   'update-ready:cancel'  → { ok, error? }   take back a now/at before the install starts
 *   'install-update-now'   → { ok, error? }   the old Install click = decide now
 *   push 'update-ready' (state | null)        whenever what the bar shows changes
 *
 * The one file a gate reads is `update-go` (README "the decision"):
 *   "<sha>"       install now: idle waived, the audio and sync checks never.
 *                 Written for "now" at once (after pausing the music through
 *                 the media-key path), and for "at" only once the time has come
 *                 AND nothing is playing and no iPod sync or CD rip runs. Until
 *                 then the app holds the time, so Change and Cancel need nothing
 *                 from the gate.
 *   "skip <sha>"  this Mac skipped the release: a v 2 gate leaves without
 *                 installing. Written again whenever the offer reappears.
 *
 * On start any leftover go-file is removed: a go-file can only outlive a
 * click when the gate it was meant for is gone, and the next gate must not
 * find a stale yes waiting for it. (A skip is written again from the decision
 * file the moment its offer is seen.)
 *
 * Electron-free (the registrar and paths arrive injected), so node --test
 * drives the whole module against a temp dir.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcRegistrar } from './ipc-register.ts'
import { REFUSED_SENDER } from './ipc-register.ts'
import { INSTALL_AFTER_SYNC, type UpdateChoice, type UpdateReadyState } from '../common/update-ready.ts'
import {
  goFileBody,
  judgeMarker,
  parseMarkerText,
  sameBuild,
  sameState,
  UPDATE_GO_FILE,
  UPDATE_READY_FILE,
  type UpdateOffer,
} from './update-ready-core.ts'
import {
  cancelDecision,
  decide,
  decisionFor,
  dropStale,
  dueState,
  isSkipped,
  markStarted,
  parseDecisionFile,
  skipFileBody,
  UPDATE_DECISION_FILE,
  type DecisionFile,
  type StoredDecision,
} from './update-decision-core.ts'

export interface UpdateReadyDeps {
  ipc: IpcRegistrar
  /** Electron userData — where the gate writes its markers. */
  userData: string
  /** build-provenance.ts buildSha; 'dev' when unknown (then every marker is new). */
  runningSha: string
  /** sendToRenderer('update-ready', state). */
  send: (state: UpdateReadyState | null) => void
  /** The media-key path (sendMediaKeyAction); 'pause' is idempotent in the renderer. */
  sendAction: (action: 'pause') => void
  /** An iPod sync is running (the sync engine's own flag). */
  syncInFlight: () => boolean
  /** The music is playing (the renderer's set-playback-active). Absent = never. */
  playing?: () => boolean
  /** Anything else an install must not cut short (a CD rip), in plain words; null when nothing. */
  busy?: () => string | null
  /** Flight-recorder row, info level. */
  record: (tag: string, detail?: unknown) => void
  /** An `update` event for the usage log (usage-log.ts): how homemini hears the decision. */
  usage?: (name: string, detail?: Record<string, string | number | boolean | null>, ok?: boolean) => void
  now?: () => number
  pidAlive?: (pid: number) => boolean
  pollMs?: number
  log?: (line: string) => void
}

export interface UpdateReadyHandle {
  /** Re-read the marker now; resolves after any push. */
  check: () => Promise<void>
  current: () => UpdateReadyState | null
  stop: () => void
}

const WATCH_DEBOUNCE_MS = 150
/** Longest single timer; a later time is reached through the poll. */
const MAX_TIMER_MS = 6 * 60 * 60 * 1000

/** Signal 0 asks without touching: ESRCH = gone, EPERM = alive but not ours (still alive). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Unique staging name + rename, the atomic-write.ts doctrine, for a small text file. */
async function writeTextAtomic(dest: string, body: string): Promise<void> {
  const tmp = `${dest}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    await writeFile(tmp, body, 'utf-8')
    await rename(tmp, dest)
  } catch (err) {
    await unlink(tmp).catch(() => { /* the real error is the one rethrown below */ })
    throw err
  }
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

export function startUpdateReadyWatcher(deps: UpdateReadyDeps): UpdateReadyHandle {
  const now = deps.now ?? Date.now
  const bootAt = now()
  const pidAlive = deps.pidAlive ?? processAlive
  const log = deps.log ?? ((line: string) => console.log(line))
  const usage = deps.usage ?? (() => { /* not wired */ })
  const markerPath = join(deps.userData, UPDATE_READY_FILE)
  const goPath = join(deps.userData, UPDATE_GO_FILE)
  const decisionPath = join(deps.userData, UPDATE_DECISION_FILE)
  let offer: UpdateOffer | null = null
  let current: UpdateReadyState | null = null
  let decisions: DecisionFile | null = null
  /** The go-file for this sha is written: the install has started, nothing can change it now. */
  let installingSha: string | null = null
  /** The skip go-file was written for this sha in this run. */
  let skipWrittenFor: string | null = null
  /** The waiting reason last logged, so a long wait is one line, not one per poll. */
  let waitLogged: string | null = null
  let offeredLogged: string | null = null
  let stopped = false
  let warnedRead = false
  let dueTimer: ReturnType<typeof setTimeout> | null = null

  // A yes left behind by a gate that is gone must not greet the next gate. Every
  // step waits for this, so a skip written again from the decision file is never
  // the file it removes.
  const staleGoCleared: Promise<void> = unlink(goPath).then(
    () => { deps.record('update-ready.stale-go-removed') },
    (err: unknown) => { if (errCode(err) !== 'ENOENT') console.warn('[update-ready] could not remove a stale update-go:', err instanceof Error ? err.message : err) },
  )

  const busyReason = (): string | null => {
    if (deps.syncInFlight()) return 'an iPod sync is running'
    if (deps.playing?.()) return 'the music is playing'
    return deps.busy?.() ?? null
  }

  const loadDecisions = async (): Promise<DecisionFile> => {
    if (decisions) return decisions
    let raw: unknown = null
    try { raw = parseMarkerText(await readFile(decisionPath, 'utf-8')) } catch (err) {
      if (errCode(err) !== 'ENOENT') console.warn('[update-ready] could not read update-decision.json:', err instanceof Error ? err.message : err)
    }
    decisions = parseDecisionFile(raw)
    // The install the last run started: did it land?
    const st = decisions.started
    if (st) {
      const landed = deps.runningSha !== 'dev' && sameBuild(st.sha, deps.runningSha)
      usage(landed ? 'update.installed' : 'update.install-not-landed', { sha: st.sha.slice(0, 12), choice: st.choice, startedAt: st.at, running: deps.runningSha }, landed)
      decisions = { ...decisions, started: null }
      await saveDecisions(decisions)
    }
    return decisions
  }

  const saveDecisions = async (file: DecisionFile): Promise<void> => {
    decisions = file
    await writeTextAtomic(decisionPath, `${JSON.stringify(file, null, 2)}\n`)
  }

  /** Offer + this Mac's answer → what the bar draws. */
  const compose = (): UpdateReadyState | null => {
    if (!offer || !decisions) return null
    if (isSkipped(decisions, offer.sha)) return null
    const d = decisionFor(decisions, offer.sha)
    const base: UpdateReadyState = { ...offer, phase: 'offered', at: null, waitingFor: null }
    if (installingSha && sameBuild(installingSha, offer.sha)) return { ...base, phase: 'installing', at: d?.at ?? null }
    if (!d || d.choice === 'now') return base
    const due = dueState(d, now(), bootAt, busyReason())
    if (due.kind === 'waiting') return { ...base, phase: 'waiting', at: d.at, waitingFor: due.reason }
    return { ...base, phase: 'scheduled', at: d.at }
  }

  const push = (): void => {
    const next = compose()
    if (sameState(next, current)) return
    current = next
    deps.send(next)
  }

  /** Write the go-file for a decision whose moment has come. Throws when the file can't be written. */
  const startInstall = async (d: StoredDecision, how: 'now' | 'at'): Promise<void> => {
    if (!offer) throw new Error('no-update')
    const before = decisions!
    await saveDecisions(markStarted(before, d, now()))
    try {
      await writeTextAtomic(goPath, goFileBody(offer.sha))
    } catch (err) {
      // Nothing started: the next launch must not look for an install that never was.
      await saveDecisions(before).catch((e: unknown) => { console.warn('[update-ready] could not undo the start mark:', e instanceof Error ? e.message : e) })
      throw err
    }
    installingSha = offer.sha
    const lateMs = d.at ? Math.max(0, now() - Date.parse(d.at)) : 0
    deps.record('update-ready.install-now', { sha: offer.sha, version: offer.version, choice: how })
    usage('update.install.start', { sha: offer.sha.slice(0, 12), choice: how, lateMs, kind: offer.kind })
    log(`[update-ready] install started (${how}) — update-go written for ${offer.sha.slice(0, 12)}`)
  }

  /** The "Install at…" clock: is it time, and is this Mac quiet? */
  const tick = async (): Promise<void> => {
    if (dueTimer) { clearTimeout(dueTimer); dueTimer = null }
    if (stopped || !offer || !decisions || installingSha) return
    const d = decisionFor(decisions, offer.sha)
    if (!d || d.choice !== 'at') return
    const due = dueState(d, now(), bootAt, busyReason())
    if (due.kind === 'scheduled') {
      const wait = Math.min(MAX_TIMER_MS, Math.max(1000, due.dueAt - now()))
      dueTimer = setTimeout(() => { dueTimer = null; void serial(tick) }, wait)
      dueTimer.unref?.()
      return
    }
    if (due.kind === 'waiting') {
      if (waitLogged !== due.reason) {
        waitLogged = due.reason
        usage('update.install.waiting', { sha: offer.sha.slice(0, 12), reason: due.reason, at: d.at })
        log(`[update-ready] install time for ${offer.sha.slice(0, 12)} has come — waiting: ${due.reason}`)
      }
      return
    }
    waitLogged = null
    try {
      await startInstall(d, 'at')
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      deps.record('update-ready.install-failed', { sha: offer.sha, error })
      usage('update.install.start', { sha: offer.sha.slice(0, 12), choice: 'at', error: error.slice(0, 200) }, false)
      console.warn('[update-ready] could not write update-go:', error)
    }
  }

  const evaluate = async (): Promise<void> => {
    if (stopped) return
    await staleGoCleared
    await loadDecisions()
    let next: UpdateOffer | null = null
    let text: string | null = null
    try {
      text = await readFile(markerPath, 'utf-8')
    } catch (err) {
      if (errCode(err) !== 'ENOENT' && !warnedRead) {
        warnedRead = true
        console.warn(`[update-ready] could not read ${markerPath}:`, err instanceof Error ? err.message : err)
      }
    }
    if (text !== null) {
      const verdict = judgeMarker(parseMarkerText(text), { now: now(), runningSha: deps.runningSha, pidAlive })
      if (verdict.kind === 'ready') {
        next = verdict.state
      } else if (verdict.kind === 'dead-gate') {
        // Nobody is waiting behind this file any more — the gate that wrote
        // it was killed or crashed before its own cleanup ran.
        try {
          await unlink(markerPath)
          deps.record('update-ready.dead-gate', { gatePid: verdict.gatePid })
          log(`[update-ready] removed update-ready.json — gate pid ${verdict.gatePid} is gone`)
        } catch (err) {
          if (errCode(err) !== 'ENOENT') console.warn('[update-ready] could not remove a dead gate\'s marker:', err instanceof Error ? err.message : err)
        }
      } else if (verdict.kind === 'invalid') {
        log(`[update-ready] ignoring update-ready.json (${verdict.reason})`)
      }
    }
    const wasSha = offer?.sha ?? null
    offer = next
    if (!next || !wasSha || !sameBuild(next.sha, wasSha)) installingSha = null
    // An answer for a build no longer offered goes with it: the next one replaces it.
    const kept = dropStale(decisions!, next?.sha ?? null)
    if (kept !== decisions && next) {
      usage('update.decision-dropped', { sha: decisions!.current!.sha.slice(0, 12), for: next.sha.slice(0, 12) })
      await saveDecisions(kept)
    }
    if (next && isSkipped(decisions!, next.sha)) {
      // Skipped here before: say so to the gate (again, after a restart), never show it.
      if (skipWrittenFor !== next.sha) {
        try {
          await writeTextAtomic(goPath, skipFileBody(next.sha))
          skipWrittenFor = next.sha
        } catch (err) {
          console.warn('[update-ready] could not write the skip:', err instanceof Error ? err.message : err)
        }
      }
    } else if (next && offeredLogged !== next.sha) {
      offeredLogged = next.sha
      usage('update.offered', { sha: next.sha.slice(0, 12), kind: next.kind, label: next.label, notes: next.notes.length, decides: next.decides })
    }
    const before = current
    push()
    if (!sameState(before, current)) {
      if (current) {
        deps.record('update-ready.seen', { sha: current.sha, version: current.version, phase: current.phase })
        log(`[update-ready] build ${current.sha.slice(0, 12)} (${current.version || 'version unknown'}) is staged — ${current.phase}`)
      } else if (before) {
        deps.record('update-ready.gone')
        log('[update-ready] no update waiting')
      }
    }
    await tick()
    push()
  }

  // One step at a time: a watch burst, the poll, a decision and the clock never
  // interleave, and a failure never breaks the chain.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn)
    chain = run.catch((err: unknown) => {
      console.warn('[update-ready] step failed:', err instanceof Error ? err.message : err)
    })
    return run
  }
  const check = (): Promise<void> => serial(evaluate).catch(() => { /* logged by serial */ })


  let watcher: FSWatcher | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  try {
    // The marker usually does not exist, so watch the folder and filter: a
    // file watch cannot see a file appear.
    watcher = fsWatch(deps.userData, { persistent: false }, (_event, filename) => {
      if (filename && String(filename) !== UPDATE_READY_FILE) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { debounce = null; void check() }, WATCH_DEBOUNCE_MS)
    })
    watcher.on('error', (err) => { console.warn('[update-ready] fs.watch error — polling carries on:', err.message) })
  } catch (err) {
    console.warn('[update-ready] fs.watch could not start — polling only:', err instanceof Error ? err.message : err)
  }
  // The poll re-checks the gate's pid each time, so a killed gate clears
  // the indicator within one cadence even when no file event fires; it is
  // also how a waiting "Install at…" notices the music has stopped.
  const timer = setInterval(() => { void check() }, deps.pollMs ?? 15_000)
  void check()

  deps.ipc.handle('update-ready:get', () => ({ ok: true as const, state: current }), { refuse: REFUSED_SENDER })

  /** Jake's answer. Saved first; then, for now, the pause and the go-file. */
  const answer = async (choice: UpdateChoice): Promise<{ ok: boolean; error?: string }> => {
    // Fresh read first: the gate may have died since the bar last drew.
    await check()
    return serial(async () => {
      const o = offer
      if (!o || !decisions || isSkipped(decisions, o.sha) && choice.choice !== 'skip') return { ok: false, error: 'no-update' }
      if (installingSha && sameBuild(installingSha, o.sha)) return { ok: false, error: 'installing' }
      if (choice.choice === 'now' && deps.syncInFlight()) {
        deps.record('update-ready.install-after-sync', { sha: o.sha })
        usage('update.decide', { sha: o.sha.slice(0, 12), choice: 'now', refused: 'ipod-sync' }, false)
        log('[update-ready] Install clicked during an iPod sync — nothing paused, no go-file')
        return { ok: false, error: INSTALL_AFTER_SYNC }
      }
      const r = decide(decisions, o.sha, choice, now())
      if (!r.ok) return { ok: false, error: r.error }
      try {
        await saveDecisions(r.file)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.warn('[update-ready] could not save the decision:', error)
        return { ok: false, error }
      }
      const at = choice.choice === 'at' ? r.file.current?.at ?? null : null
      usage(r.was ? 'update.change' : 'update.decide', {
        sha: o.sha.slice(0, 12), choice: choice.choice, at, was: r.was ? r.was.choice : null, wasAt: r.was?.at ?? null, kind: o.kind,
      })
      deps.record('update-ready.decide', { sha: o.sha, choice: choice.choice, at })
      waitLogged = null
      if (choice.choice === 'skip') {
        try { await writeTextAtomic(goPath, skipFileBody(o.sha)); skipWrittenFor = o.sha } catch (err) {
          console.warn('[update-ready] could not write the skip for the gate:', err instanceof Error ? err.message : err)
        }
        log(`[update-ready] ${o.sha.slice(0, 12)} skipped on this Mac`)
      } else if (choice.choice === 'now') {
        try {
          deps.sendAction('pause')
          await startInstall(r.file.current!, 'now')
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          deps.record('update-ready.install-failed', { sha: o.sha, error })
          usage('update.install.start', { sha: o.sha.slice(0, 12), choice: 'now', error: error.slice(0, 200) }, false)
          console.warn('[update-ready] could not write update-go:', error)
          return { ok: false, error }
        }
      } else {
        log(`[update-ready] ${o.sha.slice(0, 12)} will install at ${at}`)
        await tick()
      }
      push()
      return { ok: true }
    })
  }

  deps.ipc.handle('update-ready:decide', async (_e, raw: unknown) => {
    const c = raw as Partial<UpdateChoice> | null
    if (!c || typeof c !== 'object') return { ok: false, error: 'bad-choice' }
    if (c.choice === 'now' || c.choice === 'skip') return answer({ choice: c.choice })
    if (c.choice === 'at' && typeof (c as { at?: unknown }).at === 'string') return answer({ choice: 'at', at: (c as { at: string }).at })
    return { ok: false, error: 'bad-choice' }
  }, { refuse: REFUSED_SENDER })

  deps.ipc.handle('update-ready:cancel', async () => {
    await check()
    return serial(async () => {
      const o = offer
      if (!o || !decisions) return { ok: false, error: 'no-update' }
      if (installingSha && sameBuild(installingSha, o.sha)) return { ok: false, error: 'installing' }
      const r = cancelDecision(decisions, o.sha)
      if (!r) return { ok: false, error: 'nothing-to-cancel' }
      try { await saveDecisions(r.file) } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      usage('update.cancel', { sha: o.sha.slice(0, 12), was: r.was.choice, wasAt: r.was.at })
      deps.record('update-ready.cancel', { sha: o.sha, was: r.was.choice })
      waitLogged = null
      if (dueTimer) { clearTimeout(dueTimer); dueTimer = null }
      push()
      return { ok: true }
    })
  }, { refuse: REFUSED_SENDER })

  deps.ipc.handle('install-update-now', () => answer({ choice: 'now' }), { refuse: REFUSED_SENDER })

  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    if (dueTimer) { clearTimeout(dueTimer); dueTimer = null }
    if (debounce) { clearTimeout(debounce); debounce = null }
    if (watcher) { try { watcher.close() } catch { /* already closed */ } watcher = null }
  }

  return { check, current: () => current, stop }
}
