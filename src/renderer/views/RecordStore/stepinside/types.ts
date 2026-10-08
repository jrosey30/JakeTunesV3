/** One record in a crate — a real album out of the library. */
export interface CrateRecord {
  /** Stable id: the album key, so a record keeps its identity across digs. */
  id: string
  album: string
  artist: string
  year?: number | string
  /** album-art:// URL, or null when the library has no cover for it. */
  coverUrl: string | null
  /** Library track ids in running order — the record's actual sides. */
  trackIds: number[]
  owned: boolean
}

/** Where the player is and what they can touch. */
export type Interactable =
  | { kind: 'door'; label: string }
  | { kind: 'crate'; label: string }
  | { kind: 'station'; label: string }
  | { kind: 'exit'; label: string }

/** The dig: standing at a crate, flipping one sleeve at a time. */
export interface DigState {
  /** Index of the sleeve currently facing you. */
  index: number
  /** True once you've pulled this one out to read the back. */
  pulled: boolean
}
