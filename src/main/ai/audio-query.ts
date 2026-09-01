/**
 * audio-query — CLAP text-tower queries via a lazy warm helper (3d).
 *
 * The first vibe query spawns scripts/audio-embed.py --server (model
 * load ~5-10s); after that each query embeds in milliseconds over
 * JSONL stdin/stdout. Idle 10 minutes → the helper is stopped. Every
 * failure path returns null — the audio route is OPTIONAL and callers
 * fall back to the mood route; a broken venv can never break retrieval.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { join } from 'path'
import { app } from 'electron'

const IDLE_MS = 10 * 60 * 1000
const READY_TIMEOUT_MS = 60 * 1000
const QUERY_TIMEOUT_MS = 10 * 1000

let proc: ChildProcessWithoutNullStreams | null = null
let ready: Promise<boolean> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let queue: Promise<unknown> = Promise.resolve()

function repoRoot(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath()
}

function stopServer(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  if (proc) { try { proc.kill() } catch { /* already gone */ } }
  proc = null
  ready = null
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(stopServer, IDLE_MS)
}

function ensureServer(): Promise<boolean> {
  if (proc && ready) return ready
  const py = join(repoRoot(), '.venv-clap', 'bin', 'python')
  const script = join(repoRoot(), 'scripts', 'audio-embed.py')
  try {
    proc = spawn(py, [script, '--server'], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    proc = null
    return Promise.resolve(false)
  }
  const p = proc
  p.on('exit', () => { if (proc === p) { proc = null; ready = null } })
  ready = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), READY_TIMEOUT_MS)
    let buf = ''
    const onData = (d: Buffer): void => {
      buf += d.toString()
      if (buf.includes('"ready"')) {
        clearTimeout(t)
        p.stdout.off('data', onData)
        resolve(true)
      }
    }
    p.stdout.on('data', onData)
    p.on('error', () => { clearTimeout(t); resolve(false) })
    p.on('exit', () => { clearTimeout(t); resolve(false) })
  })
  return ready
}

/** Embed a text query into the CLAP space, or null when the helper is
 *  unavailable. Serialized — the helper answers one line per line. */
export function clapEmbedText(query: string): Promise<Float32Array | null> {
  const job = queue.then(async (): Promise<Float32Array | null> => {
    const ok = await ensureServer()
    if (!ok || !proc) return null
    const p = proc
    touchIdle()
    return await new Promise<Float32Array | null>((resolve) => {
      const t = setTimeout(() => { p.stdout.off('data', onData); resolve(null) }, QUERY_TIMEOUT_MS)
      let buf = ''
      const onData = (d: Buffer): void => {
        buf += d.toString()
        const nl = buf.indexOf('\n')
        if (nl < 0) return
        clearTimeout(t)
        p.stdout.off('data', onData)
        try {
          const row = JSON.parse(buf.slice(0, nl)) as { v?: number[] }
          resolve(Array.isArray(row.v) ? Float32Array.from(row.v) : null)
        } catch {
          resolve(null)
        }
      }
      p.stdout.on('data', onData)
      try {
        p.stdin.write(JSON.stringify({ q: query }) + '\n')
      } catch {
        clearTimeout(t)
        resolve(null)
      }
    })
  })
  queue = job.catch(() => null)
  return job
}

export function stopAudioQueryServer(): void {
  stopServer()
}
