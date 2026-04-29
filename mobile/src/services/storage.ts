// On-device storage for non-secret state. Secrets (NAS password) go to
// services/secureStore.ts (Keychain), NOT here.
//
// Keys are namespaced "jt." to keep them recognizable in any future
// AsyncStorage dump.

import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY_NAS_CONFIG = 'jt.nasConfig'
const KEY_SETTINGS = 'jt.mobileSettings'
const KEY_LIBRARY_CACHE = 'jt.libraryCache'
const KEY_OVERRIDES_QUEUE = 'jt.overridesQueue'

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await AsyncStorage.getItem(key)
  if (raw == null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value))
}

export const storage = {
  loadNasConfig: () => readJson(KEY_NAS_CONFIG),
  saveNasConfig: (cfg: unknown) => writeJson(KEY_NAS_CONFIG, cfg),
  loadSettings: () => readJson(KEY_SETTINGS),
  saveSettings: (s: unknown) => writeJson(KEY_SETTINGS, s),
  loadLibraryCache: () => readJson(KEY_LIBRARY_CACHE),
  saveLibraryCache: (snapshot: unknown) => writeJson(KEY_LIBRARY_CACHE, snapshot),
  loadOverridesQueue: () => readJson(KEY_OVERRIDES_QUEUE),
  saveOverridesQueue: (q: unknown) => writeJson(KEY_OVERRIDES_QUEUE, q),
  clear: async () => {
    await AsyncStorage.multiRemove([
      KEY_NAS_CONFIG,
      KEY_SETTINGS,
      KEY_LIBRARY_CACHE,
      KEY_OVERRIDES_QUEUE,
    ])
  },
}
