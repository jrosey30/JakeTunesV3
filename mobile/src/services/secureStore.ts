// Keychain-backed secret storage. Phase 0 stub: implementations land
// when react-native-keychain is added to package.json. Until then this
// module's API is the contract — callers should use it everywhere the
// NAS password is read or written so swapping in the real Keychain
// later is a one-file change.

const NAS_PASSWORD_KEY = 'jt.nasPassword'

interface SecureStore {
  setNasPassword(password: string): Promise<void>
  getNasPassword(): Promise<string | null>
  clearNasPassword(): Promise<void>
}

// Stub: in-memory only. Replace with react-native-keychain before
// shipping any build that talks to a real NAS.
const stub: SecureStore = (() => {
  let mem: string | null = null
  return {
    async setNasPassword(password: string) {
      mem = password
    },
    async getNasPassword() {
      return mem
    },
    async clearNasPassword() {
      mem = null
    },
  }
})()

export const secureStore: SecureStore = stub
export { NAS_PASSWORD_KEY }
