// Keychain-backed secret storage for the NAS password.
//
// Phase 1: real react-native-keychain implementation. iOS stores the
// secret in Keychain (Apple's hardware-backed secret store); Android
// uses the equivalent EncryptedSharedPreferences via the library's
// platform shim.
//
// Phase 0 history (kept for context, not for code): there used to be
// an in-memory stub here. CLAUDE.md flagged it as "must replace
// before any build hits a real NAS." This file IS the replacement.
// Do not put the password in AsyncStorage or anywhere else — the
// Electron-renderer rule about secret handling applies here too:
// the only place this string lives at rest is the Keychain.
//
// API contract is unchanged from the stub so callers
// (ConnectionContext, synologyClient.login) don't need to change.
//
// Keychain service identifier: `jt.nasPassword`. The "service" string
// is what shows up in iOS's Keychain Access app and what other
// processes would see if they tried to enumerate. Don't change it
// without a migration plan — existing installs would lose their
// stored credential.

import * as Keychain from 'react-native-keychain'

const NAS_PASSWORD_KEY = 'jt.nasPassword'

// Keychain demands a username AND password — a quirk of the
// Generic-Password storage model on iOS. We don't actually use the
// stored username (the NAS username lives on NasConnectionConfig);
// the keychain entry's username slot just holds a constant marker
// so the entry is consistent if you inspect it from outside.
const KEYCHAIN_USERNAME_SLOT = 'nas'

interface SecureStore {
  setNasPassword(password: string): Promise<void>
  getNasPassword(): Promise<string | null>
  clearNasPassword(): Promise<void>
}

export const secureStore: SecureStore = {
  async setNasPassword(password: string): Promise<void> {
    await Keychain.setGenericPassword(KEYCHAIN_USERNAME_SLOT, password, {
      service: NAS_PASSWORD_KEY,
      // Default `accessible` is AFTER_FIRST_UNLOCK, which means the
      // secret is readable any time after the first device unlock
      // post-boot — including in the background, which we need
      // because playback (and the override-queue export later) can
      // run in the background. WHEN_UNLOCKED would block the
      // background JS context from reading the password.
      accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK,
    })
  },

  async getNasPassword(): Promise<string | null> {
    const credentials = await Keychain.getGenericPassword({
      service: NAS_PASSWORD_KEY,
    })
    if (!credentials) return null
    return credentials.password
  },

  async clearNasPassword(): Promise<void> {
    await Keychain.resetGenericPassword({ service: NAS_PASSWORD_KEY })
  },
}

export { NAS_PASSWORD_KEY }
