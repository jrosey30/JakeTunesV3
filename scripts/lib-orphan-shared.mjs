// Shared music-root resolution + orphan helpers for CLI scripts.
// Mirrors resolveMusicDir() in src/main/index.ts (Brief 011b three-tier).

import { readFileSync, existsSync, statSync } from 'fs'
import { readdir } from 'fs/promises'
import { join, basename, extname } from 'path'
import { homedir } from 'os'

export const LIBRARY_PATH = join(homedir(), 'Library/Application Support/JakeTunes/library.json')
export const APP_SETTINGS_PATH = join(homedir(), 'Library/Application Support/JakeTunes/app-settings.json')
export const LEGACY_MUSIC_DIR = join(homedir(), 'Music2/JakeTunesLibrary/iPod_Control/Music')
export const DEFAULT_MUSIC_DIR = join(homedir(), 'Music/JakeTunesLibrary/iPod_Control/Music')

export const AUDIO_EXTS = new Set([
  '.m4a', '.mp3', '.flac', '.aac', '.wav', '.alac', '.aiff', '.aif', '.m4p', '.m4b',
])

export function countFDirs(musicDir) {
  if (!existsSync(musicDir)) return -1
  let count = 0
  for (let i = 0; i < 50; i++) {
    const fName = `F${String(i).padStart(2, '0')}`
    if (existsSync(join(musicDir, fName))) count++
  }
  return count
}

export function resolveMusicDir() {
  // Tier 1: explicit musicRoot in app-settings.json
  try {
    const raw = readFileSync(APP_SETTINGS_PATH, 'utf8')
    const settings = JSON.parse(raw)
    const musicRoot = settings?.library?.musicRoot
    if (musicRoot && typeof musicRoot === 'string') {
      const explicit = join(musicRoot, 'iPod_Control/Music')
      if (existsSync(explicit)) {
        return { musicDir: explicit, source: `explicit: ${musicRoot}` }
      }
    }
  } catch { /* no settings or unreadable */ }

  const legacyExists = existsSync(LEGACY_MUSIC_DIR)
  const defaultExists = existsSync(DEFAULT_MUSIC_DIR)

  if (legacyExists && defaultExists) {
    const legacyCount = countFDirs(LEGACY_MUSIC_DIR)
    const defaultCount = countFDirs(DEFAULT_MUSIC_DIR)
    if (defaultCount > legacyCount) {
      return { musicDir: DEFAULT_MUSIC_DIR, source: `default wins F-count (${defaultCount} vs ${legacyCount})` }
    }
    if (legacyCount > defaultCount) {
      return { musicDir: LEGACY_MUSIC_DIR, source: `legacy wins F-count (${legacyCount} vs ${defaultCount})` }
    }
    try {
      const legacyMtime = statSync(LEGACY_MUSIC_DIR).mtimeMs
      const defaultMtime = statSync(DEFAULT_MUSIC_DIR).mtimeMs
      const winner = defaultMtime > legacyMtime ? DEFAULT_MUSIC_DIR : LEGACY_MUSIC_DIR
      return { musicDir: winner, source: 'mtime tiebreak' }
    } catch {
      return { musicDir: DEFAULT_MUSIC_DIR, source: 'tiebreak fallback' }
    }
  }

  if (legacyExists) return { musicDir: LEGACY_MUSIC_DIR, source: 'legacy only' }
  if (defaultExists) return { musicDir: DEFAULT_MUSIC_DIR, source: 'default only' }
  return { musicDir: DEFAULT_MUSIC_DIR, source: 'no candidates; default path' }
}

export function loadLibrary() {
  const lib = JSON.parse(readFileSync(LIBRARY_PATH, 'utf8'))
  const tracks = Array.isArray(lib.tracks) ? lib.tracks : []
  const indexed = new Set(tracks.map((t) => basename(String(t.path || '').replace(/:/g, '/'))))
  return { lib, tracks, indexed }
}

export async function walkAudioFiles(dir) {
  let out = []
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out = out.concat(await walkAudioFiles(p))
    else if (AUDIO_EXTS.has(extname(e.name).toLowerCase())) out.push(p)
  }
  return out
}

export function isOrphanFile(filePath, indexedBasenames) {
  const fn = basename(filePath)
  if (fn.startsWith('._')) return { orphan: true, reason: 'macOS resource fork' }
  if (!indexedBasenames.has(fn)) return { orphan: true, reason: 'not in library.json' }
  return { orphan: false }
}
