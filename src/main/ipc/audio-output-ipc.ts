/**
 * Audio output IPC: sound settings, device list/selection, call watch
 * (mic-activity polling that ducks music routing during calls).
 *
 * Extracted from main/index.ts (6.0 Phase 1 IPC migration) — bodies
 * verbatim; the watch timer/state now lives module-locally.
 */
import { app } from 'electron'
import { join } from 'path'
import { open } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { IS_MAC, IS_WINDOWS, audioHelperRelPath } from '../platform'
import { safeIpcError } from '../safe-ipc-error'

export interface AudioOutputIpcHost {
  sendToRenderer: (channel: string, ...args: unknown[]) => void
}

export function registerAudioOutputIpc(ipc: IpcRegistrar, host: AudioOutputIpcHost): void {
  ipc.handle('open-sound-settings', async () => {
    const { exec } = await import('child_process')
    if (IS_MAC) {
      exec('open "x-apple.systempreferences:com.apple.Sound-Settings.extension?output"')
    } else if (IS_WINDOWS) {
      // ms-settings:sound is the deep link to Windows 10/11 Sound settings.
      exec('start ms-settings:sound')
    }
  }, { refuse: undefined })

  ipc.handle('list-audio-devices', async () => {
    const relPath = audioHelperRelPath()
    if (!relPath) {
      // No native helper on this platform — fall back to empty list so UI
      // gracefully shows "default device" rather than erroring.
      return { ok: true, devices: [] }
    }
    const helperPath = join(
      app.isPackaged ? process.resourcesPath : app.getAppPath(),
      relPath
    )
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execP = promisify(execFile)
      const { stdout } = await execP(helperPath, ['list'], { timeout: 5000 })
      return { ok: true, devices: JSON.parse(stdout) }
    } catch (err) {
      console.error('[AudioHelper] list failed:', err)
      return { ok: false, devices: [], error: safeIpcError(err, 'tool-failed') }
    }
  }, { public: true })

  ipc.handle('set-audio-device', async (_e, deviceId: number) => {
    const relPath = audioHelperRelPath()
    if (!relPath) {
      return { ok: false, error: 'Audio device selection is not supported on this platform yet.' }
    }
    const helperPath = join(
      app.isPackaged ? process.resourcesPath : app.getAppPath(),
      relPath
    )
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execP = promisify(execFile)
      const { stdout } = await execP(helperPath, ['set', String(deviceId)], { timeout: 5000 })
      return JSON.parse(stdout)
    } catch (err) {
      console.error('[AudioHelper] set failed:', err)
      return { ok: false, error: safeIpcError(err, 'tool-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  // ── Bandcamp Store: download → library bridge ──
  // Reuses importOneFile() (dedupe / convert / tag-embed / hashed-folder
  // placement) so Bandcamp purchases route exactly like any other import.
  // Injected into the Bandcamp integration to keep that module decoupled.
  // nextLibraryId / importDownloadedFiles moved to import-pipeline.ts
  // (renovation P1C1); wired via initImportPipeline at startup.

  // 4.4.51: microphone-activity watcher for the auto-route-on-call
  // feature. The renderer ARMS this (set-call-watch true) only while
  // music is playing AND the call-route setting is on; main then polls
  // `audio_helper mic-status` every ~3s and fires `call-state-changed`
  // on each true↔false flip. The renderer reacts by routing JakeTunes'
  // OWN audio output (AudioContext.setSinkId) to the configured speaker
  // — the system default output is never touched, so a Teams/Zoom call
  // keeps using whatever the OS has it on. Gated-polling (not always-on)
  // mirrors the 4.4.15 output-device-disconnect watcher.
  let callWatchTimer: ReturnType<typeof setInterval> | null = null
  let lastMicActive: boolean | null = null

  async function pollMicStatus(): Promise<void> {
    const relPath = audioHelperRelPath()
    if (!relPath) return
    const helperPath = join(
      app.isPackaged ? process.resourcesPath : app.getAppPath(),
      relPath
    )
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execP = promisify(execFile)
      const { stdout } = await execP(helperPath, ['mic-status'], { timeout: 4000 })
      const parsed = JSON.parse(stdout) as { ok?: boolean; micActive?: boolean }
      const active = !!parsed.micActive
      if (lastMicActive === null) {
        // First reading establishes the baseline. If the mic is ALREADY
        // active when we arm (music started during a call), fire once so
        // the renderer routes immediately — otherwise stay quiet.
        lastMicActive = active
        if (active) host.sendToRenderer('call-state-changed', { onCall: true })
        return
      }
      if (active !== lastMicActive) {
        lastMicActive = active
        host.sendToRenderer('call-state-changed', { onCall: active })
      }
    } catch {
      // mic-status failed (helper missing / timeout) — stay quiet, retry next tick.
    }
  }

  ipc.handle('set-call-watch', (_e, armed: boolean) => {
    if (armed) {
      if (callWatchTimer) return { ok: true }
      lastMicActive = null               // re-baseline on (re)arm
      void pollMicStatus()               // immediate first read
      callWatchTimer = setInterval(() => { void pollMicStatus() }, 3000)
    } else {
      if (callWatchTimer) { clearInterval(callWatchTimer); callWatchTimer = null }
      lastMicActive = null
    }
    return { ok: true }
  }, { refuse: { ok: false } })
}
