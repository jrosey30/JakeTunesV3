/**
 * CD drive IPC: detection, disc info, track ripping, eject.
 *
 * Extracted from main/index.ts (6.0 Phase 1 IPC migration). Bodies are
 * verbatim; shared machinery arrives via CdIpcHost (the two late-bound
 * cache hooks are read through the host at call time, matching their
 * `let` rebinding at protocol-handler init).
 */
import { app } from 'electron'
import { join } from 'path'
import { mkdir, open, readdir, stat, unlink } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { findFreeImportedId } from '../import-pipeline'
import {
  IS_MAC, type AudioFormat, convertAudio, ejectOpticalMedia, extensionForFormat,
  hasOpticalMedia, listMountPoints, volumeNameFromMount,
} from '../platform'
import { safeIpcError } from '../safe-ipc-error'

export interface CdIpcHost {
  getMusicDir: () => string
  getMount: () => string | null
  computeAudioFingerprint: (absPath: string, durationMs: number) => Promise<string | null>
  enqueueAnalysisForImportedTrack: (t: Record<string, unknown>) => void
  enqueueStreamConvert: (ipodPath: string, fingerprint: string | undefined, enqueuedAt: number) => Promise<void>
  prewarmAlacCache: (paths: string[]) => Promise<void>
  readStreamSource: () => Promise<'homemini' | null>
  registerKnownCodec: (path: string, mtime: number, codec: string) => void
  sendToRenderer: (channel: string, ...args: unknown[]) => void
}

export function registerCdIpc(ipc: IpcRegistrar, host: CdIpcHost): void {
  // ── CD Drive Detection & Import ──

  async function detectAudioCD(): Promise<{ hasCd: boolean; volumeName?: string; volumePath?: string; trackCount?: number }> {
    try {
      // Ask the platform helper whether any optical drive has media.
      const hasMedia = await hasOpticalMedia()
      if (!hasMedia) return { hasCd: false }

      // Now find the mount point that contains the audio CD tracks.
      // macOS: CDs mount as AIFF files under /Volumes/DISC_NAME
      // Windows: CDs appear as a drive letter with .cda placeholder files
      const { readdir: readdirFS } = await import('fs/promises')
      const mounts = await listMountPoints()

      // Volumes to skip (the iPod and the system drive).
      const skipMounts = new Set<string>()
      const ipodMount = host.getMount()
      if (ipodMount) skipMounts.add(ipodMount)
      if (IS_MAC) {
        skipMounts.add('/Volumes/Macintosh HD')
        skipMounts.add('/Volumes/Macintosh HD - Data')
      }

      for (const mountPath of mounts) {
        if (skipMounts.has(mountPath)) continue
        try {
          const files = await readdirFS(mountPath)
          // macOS exposes tracks as .aiff/.aif, Windows exposes them as .cda.
          const audioFiles = files.filter(f => {
            const lower = f.toLowerCase()
            return lower.endsWith('.aiff') || lower.endsWith('.aif') || lower.endsWith('.cda')
          })
          if (audioFiles.length >= 2) {
            return {
              hasCd: true,
              volumeName: volumeNameFromMount(mountPath),
              volumePath: mountPath,
              trackCount: audioFiles.length,
            }
          }
        } catch { /* not readable */ }
      }

      // Disc present but no track files visible (could be a data disc).
      return { hasCd: false }
    } catch {
      return { hasCd: false }
    }
  }

  ipc.handle('check-cd-drive', async () => {
    return detectAudioCD()
  }, { public: true })

  ipc.handle('get-cd-info', async () => {
    const cd = await detectAudioCD()
    if (!cd.hasCd || !cd.volumePath) {
      return { ok: false, error: 'No audio CD found' }
    }

    try {
      const { readdir: readdirFS } = await import('fs/promises')
      const mm = await import('music-metadata')

      const files = await readdirFS(cd.volumePath)
      const aiffFiles = files
        .filter(f => f.toLowerCase().endsWith('.aiff') || f.toLowerCase().endsWith('.aif'))
        .sort((a, b) => {
          const numA = parseInt(a) || 0
          const numB = parseInt(b) || 0
          return numA - numB
        })

      const tracks: { number: number; title: string; duration: number; filePath: string }[] = []
      for (let i = 0; i < aiffFiles.length; i++) {
        const filePath = join(cd.volumePath, aiffFiles[i])
        let title = aiffFiles[i].replace(/\.(aiff|aif)$/i, '')
        let duration = 0

        try {
          const metadata = await mm.parseFile(filePath)
          if (metadata.common.title) title = metadata.common.title
          duration = Math.round((metadata.format.duration || 0) * 1000)
        } catch { /* use filename as title */ }

        tracks.push({ number: i + 1, title, duration, filePath })
      }

      // Look up metadata from MusicBrainz using TOC
      let artist = ''
      let album = cd.volumeName || 'Audio CD'
      let year = ''
      let genre = ''

      if (tracks.length > 0) {
        const durations = tracks.map(t => t.duration)
        const framesPerSecond = 75
        let offset = 150 // 2-second pregap
        const offsets: number[] = []
        for (let i = 0; i < durations.length; i++) {
          offsets.push(offset)
          offset += Math.round((durations[i] / 1000) * framesPerSecond)
        }
        const leadOut = offset
        const toc = `1 ${durations.length} ${leadOut} ${offsets.join(' ')}`

        try {
          // Include release-groups + tags so we can fall back to the group's
          // first-release date when a specific release has no date, and pull
          // a genre from MusicBrainz release / release-group tags.
          const url = `https://musicbrainz.org/ws/2/discid/-?toc=${encodeURIComponent(toc)}&fmt=json&cdstubs=no&inc=recordings+artist-credits+release-groups+tags`
          const res = await fetch(url, {
            headers: { 'User-Agent': `JakeTunes/${app.getVersion()} (jaketunes@example.com)` }
          })
          if (res.ok) {
            type MBTag = { name: string; count?: number }
            const data = await res.json() as {
              releases?: Array<{
                id: string
                title: string
                date?: string
                'artist-credit'?: Array<{ artist: { name: string } }>
                media?: Array<{ tracks?: Array<{ position: number; title: string }> }>
                'release-group'?: { 'first-release-date'?: string; tags?: MBTag[] }
                tags?: MBTag[]
              }>
            }
            const releases = data.releases || []
            // Pick release with matching track count
            const release = releases.find(r => {
              const disc = (r.media || [])[0]
              return disc?.tracks?.length === tracks.length
            }) || releases[0]

            if (release) {
              artist = release['artist-credit']?.[0]?.artist?.name || ''
              album = release.title || album
              // Prefer the specific release date; fall back to the
              // release-group's first-release-date (better coverage for
              // compilations / remasters whose release has no date).
              year = release.date?.split('-')[0]
                || release['release-group']?.['first-release-date']?.split('-')[0]
                || ''

              // Genre from top-tagged tag name. Release-level tags are
              // usually more specific; fall back to release-group tags.
              const pickTopTag = (tags?: MBTag[]): string => {
                if (!tags || tags.length === 0) return ''
                const sorted = [...tags].sort((a, b) => (b.count || 0) - (a.count || 0))
                const name = sorted[0]?.name || ''
                // Title-case it so "rock" → "Rock", "hip hop" → "Hip Hop"
                return name ? name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : ''
              }
              genre = pickTopTag(release.tags) || pickTopTag(release['release-group']?.tags) || ''

              const mbTracks = (release.media || [])[0]?.tracks || []
              for (let i = 0; i < Math.min(tracks.length, mbTracks.length); i++) {
                if (mbTracks[i].title) tracks[i].title = mbTracks[i].title
              }
            }
          }
        } catch { /* MusicBrainz lookup failed, continue with defaults */ }
      }

      return { ok: true, volumeName: cd.volumeName, volumePath: cd.volumePath, artist, album, year, genre, tracks }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { public: true })

  // Stage a CDDA track to local disk with LARGE sequential reads before
  // converting. cddafs punishes small reads — measured on a real slow disc
  // (As We Bop, MCA 1988, GU90N drive): ffmpeg reading the mount directly
  // averaged ~150 KB/s (341s for one 4:50 track), while 4MB block reads
  // sustained 417-587 KB/s across the disc. Staging first cuts a full-CD rip
  // from ~40+ minutes to ~12-14 on that hardware; converting the local copy
  // then takes seconds per track. Each individual read gets a 120s guard so
  // a genuinely dead drive errors out instead of hanging the rip forever.
  async function stageCdTrackLocally(src: string, dest: string): Promise<void> {
    const srcH = await open(src, 'r')
    try {
      const dstH = await open(dest, 'w')
      try {
        const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
        while (true) {
          const read = srcH.read(buf, 0, buf.length, -1)
          const guard = new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error('CD read stalled (no data for 120s) — drive or disc problem')), 120000)
            void read.finally(() => clearTimeout(t))
          })
          const { bytesRead } = await Promise.race([read, guard])
          if (bytesRead <= 0) break
          await dstH.write(buf, 0, bytesRead)
        }
      } finally {
        await dstH.close()
      }
    } finally {
      await srcH.close()
    }
  }

  ipc.handle('rip-cd-tracks', async (_e,
    cdTracks: Array<{ number: number; title: string; duration: number; filePath: string }>,
    metadata: { artist: string; album: string; year: string; genre: string },
    nextId: number,
    format?: string
  ) => {
    const imported: Array<Record<string, unknown>> = []

    // The renderer passes `nextId = max(library.id, max-imported-NNNN-in-paths)
    // + 1` (App.tsx useEffect, fixed Apr 26). The on-disk scan below is the
    // belt-and-suspenders second line of defense: if disk has orphan files
    // from a prior session that never made it into library.json, or any
    // other source of drift, `findFreeImportedId` walks forward until it
    // finds a free slot.
    //
    // ⚠️ TWIN: same helper is used by `import-track`'s `importOneFile`.
    // Centralizes the scan so we don't ship two versions that drift apart.
    let id = await findFreeImportedId(nextId)
    if (id !== nextId) {
      console.warn(`rip-cd-tracks: nextId ${nextId} collides with existing file imported_${nextId}.*; bumped to ${id}`)
    }

    // Validate and default the format.
    const validFormats: AudioFormat[] = ['aac-128', 'aac-256', 'aac-320', 'alac', 'aiff', 'wav']
    const fmt: AudioFormat = validFormats.includes(format as AudioFormat)
      ? (format as AudioFormat)
      : 'aac-256'
    const destExt = extensionForFormat(fmt)

    const cdBatchBaseTime = Date.now()
    let cdTrackIndex = 0

    for (const cdTrack of cdTracks) {
      // Re-check before each track in case the previous iteration's id
      // has now been written and we're about to land on a slot a parallel
      // process took. Cheap (single stat per ext when no collision).
      id = await findFreeImportedId(id)
      const subDir = `F${String(id % 50).padStart(2, '0')}`
      const destDir = join(host.getMusicDir(), subDir)
      await mkdir(destDir, { recursive: true })

      const fileName = `imported_${id}${destExt}`
      const destPath = join(destDir, fileName)

      const stagedPath = join(app.getPath('temp'), `jaketunes-cdstage-${id}.aiff`)
      try {
        const yearStr = metadata.year ? String(parseInt(metadata.year, 10) || '') : ''
        // Read the track off the disc FIRST with big sequential reads (see
        // stageCdTrackLocally — ~3x faster than letting ffmpeg/afconvert read
        // the cddafs mount), then convert the local copy. The duration-scaled
        // watchdog stays as belt-and-suspenders: 4× duration + 2 min, min
        // 5 min — slow-but-progressing converts finish, hung encoders die.
        const ripTimeoutMs = Math.max(300000, Math.round((cdTrack.duration || 0) * 1000 * 4) + 120000)
        await stageCdTrackLocally(cdTrack.filePath, stagedPath)
        await convertAudio(stagedPath, destPath, fmt, {
          title: cdTrack.title,
          artist: metadata.artist,
          album: metadata.album,
          albumArtist: metadata.artist,
          genre: metadata.genre,
          year: yearStr,
          trackNumber: cdTrack.number,
          trackCount: cdTracks.length,
          discNumber: 1,
          discCount: 1,
        }, { timeoutMs: ripTimeoutMs })

        const fileStats = await stat(destPath)
        const cdTrackTime = new Date(cdBatchBaseTime + cdTrackIndex)

        // Stage 3 ingestion redirect (twin of the importOneFile hook): in
        // homemini streaming mode, enqueue this non-ALAC rip for background
        // conversion to a streamed symlink once homemini serves matching bytes.
        // Fingerprint is computed just for the identity gate; the track's stored
        // fingerprint is still backfilled later by verifyAndHealTracks as before.
        if (fmt !== 'alac' && (await host.readStreamSource()) === 'homemini') {
          const cdFp = await host.computeAudioFingerprint(destPath, (cdTrack.duration || 0) * 1000)
          if (cdFp) void host.enqueueStreamConvert(`:iPod_Control:Music:${subDir}:${fileName}`, cdFp, Date.now())
        }

        imported.push({
          id,
          title: cdTrack.title,
          artist: metadata.artist,
          album: metadata.album,
          genre: metadata.genre,
          year: metadata.year ? parseInt(metadata.year, 10) || '' : '',
          duration: cdTrack.duration,
          path: `:iPod_Control:Music:${subDir}:${fileName}`,
          trackNumber: cdTrack.number,
          trackCount: cdTracks.length,
          discNumber: 1,
          discCount: 1,
          playCount: 0,
          dateAdded: cdTrackTime.toISOString(),
          fileSize: fileStats.size,
          rating: 0,
          // Brief 031 Phase 4b: same default as the file-import path —
          // newly-ripped CD tracks land with [artist] as their
          // contributingArtists. Collab splits stay one-shot.
          contributingArtists: [metadata.artist || ''],
        })
        // BPM/key analysis starts the moment the rip lands — CD rips were the
        // other road that skipped it.
        host.enqueueAnalysisForImportedTrack(imported[imported.length - 1] as unknown as Record<string, unknown>)

        // Send per-track progress to renderer, including the just-imported
        // track record so the library can add it immediately instead of
        // waiting for the whole batch to finish.
        host.sendToRenderer('cd-rip-progress', {
          current: imported.length,
          total: cdTracks.length,
          trackNumber: cdTrack.number,
          trackTitle: cdTrack.title,
          track: imported[imported.length - 1],
        })

        id++
        cdTrackIndex++
      } catch (err) {
        console.error(`Failed to rip track ${cdTrack.number}:`, err)
        host.sendToRenderer('cd-rip-progress', {
          current: imported.length,
          total: cdTracks.length,
          trackNumber: cdTrack.number,
          trackTitle: cdTrack.title,
          error: safeIpcError(err, 'io-failed'),
        })
      } finally {
        await unlink(stagedPath).catch(() => {})
      }
    }

    // Resolve the just-imported tracks' on-disk paths once — used for
    // both pre-warming ALAC transcodes and for pre-registering their
    // codec with the play handler so first-play doesn't have to ffprobe.
    const localMount = host.getMusicDir().replace(/[/\\]iPod_Control[/\\]Music$/, '')
    const importedAbsPaths = imported.map(t => {
      const hfs = (t.path as string) || ''
      const rel = hfs.replace(/^:/, '').replace(/:/g, '/')
      return join(localMount, rel)
    }).filter(Boolean)

    // Pre-register codec (we know it — we just wrote it).
    // 'alac' for lossless rips, 'aac' for AAC 128/256/320.
    const knownCodec = fmt === 'alac' ? 'alac' : fmt.startsWith('aac-') ? 'aac' : ''
    if (knownCodec) {
      for (const p of importedAbsPaths) {
        try {
          const s = await stat(p)
          host.registerKnownCodec(p, s.mtimeMs, knownCodec)
        } catch { /* file missing — skip */ }
      }
    }

    // If we ripped as ALAC, transcode the play-cache mirror NOW (await).
    // Same reasoning as importOneFile — user is already in rip-progress
    // UI; an extra few seconds is invisible. First-play is then instant.
    if (fmt === 'alac') {
      await host.prewarmAlacCache(importedAbsPaths).catch(err => console.warn('pre-warm failed:', err))
    }

    return { ok: true, tracks: imported }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('eject-cd', async () => {
    try {
      await ejectOpticalMedia()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { refuse: REFUSED_SENDER })

}
